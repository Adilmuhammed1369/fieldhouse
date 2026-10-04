import 'dotenv/config'
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { GAMES, LOCATIONS } from './shared/booking-options.js'

const app = express()
const port = Number(process.env.PORT || 4001)
const indiaOffset = '+05:30'
const slotMinutes = 15
const authCookieName = 'fieldhouse_session'
const adminCookieName = 'fieldhouse_admin_session'
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() || ''
const adminPassword = process.env.ADMIN_PASSWORD || ''
const adminPasswordHash = adminPassword ? bcrypt.hash(adminPassword, 12) : null
let hourlyRateInr = Number(process.env.TURF_HOURLY_RATE_INR || 500)
const razorpayKeyId = process.env.RAZORPAY_KEY_ID?.trim() || ''
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || ''
const razorpayConfigured = /^rzp_(test|live)_/.test(razorpayKeyId) && razorpayKeySecret.length > 0
const authCookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
}
const adminCookieOptions = { ...authCookieOptions, maxAge: 8 * 60 * 60 * 1000 }
let databaseReady = false

mongoose.connection.on('disconnected', () => {
  databaseReady = false
  console.error('MongoDB Atlas disconnected; booking requests are temporarily unavailable.')
})

mongoose.connection.on('reconnected', () => {
  databaseReady = true
  console.log('Reconnected to MongoDB Atlas.')
})

app.use(express.json({ limit: '10kb' }))
app.use(cookieParser())

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
}, { timestamps: true })

const bookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  contactName: { type: String, required: true, trim: true },
  contactEmail: { type: String, required: true, lowercase: true, trim: true },
  contactPhone: { type: String, required: true, trim: true },
  location: { type: String, required: true, enum: LOCATIONS },
  game: { type: String, required: true, enum: GAMES },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  durationHours: { type: Number, required: true, min: 1, max: 12 },
  paymentMethod: { type: String, enum: ['cash', 'upi', 'razorpay'], default: 'cash', required: true },
  paymentStatus: { type: String, enum: ['cash_due', 'pending', 'paid', 'demo_paid', 'cancelled'], default: 'cash_due', required: true },
  totalAmountInr: { type: Number, required: true, min: 1 },
  razorpayOrderId: { type: String, default: '' },
  paymentExpiresAt: { type: Date, default: null },
  paymentId: { type: String, default: '' },
  reference: { type: String, required: true, unique: true },
  status: { type: String, enum: ['confirmed', 'cancelled', 'expired'], default: 'confirmed', required: true },
}, { timestamps: true })

const slotSchema = new mongoose.Schema({
  location: { type: String, required: true },
  startsAt: { type: Date, required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { versionKey: false })
slotSchema.index({ location: 1, startsAt: 1 }, { unique: true })

const settingsSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  hourlyRateInr: { type: Number, required: true, min: 1 },
}, { versionKey: false })

const reviewSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  customerName: { type: String, required: true, trim: true, maxlength: 80 },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, trim: true, maxlength: 500, default: '' },
}, { timestamps: true })

const User = mongoose.model('User', userSchema)
const Booking = mongoose.model('Booking', bookingSchema)
const Slot = mongoose.model('BookingSlot', slotSchema)
const Settings = mongoose.model('Settings', settingsSchema)
const Review = mongoose.model('Review', reviewSchema)

const reconcileBookingSlots = async () => {
  const lockedBookingIds = await Slot.distinct('bookingId')
  const migrated = lockedBookingIds.length
    ? await Booking.updateMany(
      {
        _id: { $in: lockedBookingIds },
        $or: [{ status: { $exists: false } }, { status: null }],
      },
      { $set: { status: 'confirmed' } },
      { runValidators: true },
    )
    : { modifiedCount: 0 }

  const staleLocks = await Slot.aggregate([
    {
      $lookup: {
        from: Booking.collection.name,
        localField: 'bookingId',
        foreignField: '_id',
        as: 'booking',
      },
    },
    { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
    { $match: { 'booking.status': { $ne: 'confirmed' } } },
    { $group: { _id: '$bookingId' } },
  ])
  const deleted = staleLocks.length
    ? await Slot.deleteMany({ bookingId: { $in: staleLocks.map(({ _id }) => _id) } })
    : { deletedCount: 0 }

  if (migrated.modifiedCount || deleted.deletedCount) {
    console.log(`Reconciled booking slots: ${migrated.modifiedCount} legacy bookings restored, ${deleted.deletedCount} stale locks removed.`)
  }
}

const cancelBooking = async ({ bookingId, userId }) => {
  const session = await mongoose.startSession()
  let outcome
  try {
    await session.withTransaction(async () => {
      const filter = { _id: bookingId, status: 'confirmed' }
      if (userId) {
        filter.userId = userId
        filter.startAt = { $gt: new Date() }
      }

      const booking = await Booking.findOne(filter).session(session).lean()
      if (!booking) {
        outcome = { status: 404, error: userId
          ? 'Upcoming booking not found. Started, cancelled, or other users’ bookings cannot be cancelled.'
          : 'Confirmed booking not found.' }
        return
      }
      if (booking.paymentMethod === 'razorpay' && booking.paymentStatus === 'paid') {
        outcome = { status: 409, error: 'Refund the captured Razorpay payment before cancelling this booking.' }
        return
      }

      const updateFields = { status: 'cancelled' }
      if (booking.paymentStatus !== 'paid') updateFields.paymentStatus = 'cancelled'
      const updateFilter = {
        ...filter,
        $or: [{ paymentMethod: { $ne: 'razorpay' } }, { paymentStatus: { $ne: 'paid' } }],
      }
      const result = await Booking.updateOne(
        updateFilter,
        { $set: updateFields },
        { runValidators: true, session },
      )
      if (result.modifiedCount !== 1) {
        outcome = { status: 409, error: 'This booking changed before it could be cancelled. Refresh and try again.' }
        return
      }

      await Slot.deleteMany({ bookingId: booking._id }, { session })
      const cancelledBooking = await Booking.findById(booking._id).session(session).lean()
      outcome = { booking: serializeBooking(cancelledBooking) }
    })
    return outcome
  } finally {
    await session.endSession()
  }
}

const parseLocalDateTime = (date, time) => new Date(`${date}T${time}:00${indiaOffset}`)
const formatIndiaDate = (value) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
}).format(value)
const formatIndiaTime = (value) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}).format(value)

const razorpayRequest = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  })
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('Razorpay returned an invalid response.')
  }
  if (!response.ok) {
    throw new Error(data?.error?.description || `Razorpay request failed with HTTP ${response.status}.`)
  }
  return data
}

const serializeBooking = (booking) => ({
  id: booking._id.toString(),
  contactName: booking.contactName,
  contactEmail: booking.contactEmail,
  contactPhone: booking.contactPhone,
  location: booking.location,
  game: booking.game,
  startAt: booking.startAt,
  endAt: booking.endAt,
  durationHours: booking.durationHours,
  paymentMethod: booking.paymentMethod || 'cash',
  paymentStatus: booking.paymentStatus === 'demo_paid' ? 'pending' : booking.paymentStatus || 'cash_due',
  totalAmountInr: booking.totalAmountInr || hourlyRateInr * booking.durationHours,
  razorpayOrderId: booking.razorpayOrderId || '',
  paymentExpiresAt: booking.paymentExpiresAt || null,
  reference: booking.reference,
  status: booking.status,
})

const serializeAvailability = (booking) => ({
  id: booking._id.toString(),
  location: booking.location,
  game: booking.game,
  startAt: booking.startAt,
  endAt: booking.endAt,
  durationHours: booking.durationHours,
})

const serializeUser = (user) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  phone: user.phone,
})

const serializeReview = (review) => ({
  id: review._id.toString(),
  bookingId: review.bookingId.toString(),
  customerName: review.customerName,
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt,
})

const signIn = (response, user) => {
  const token = jwt.sign({ sub: user._id.toString() }, process.env.AUTH_TOKEN_SECRET, { expiresIn: '7d' })
  response.cookie(authCookieName, token, authCookieOptions)
}

const requireAuth = (request, response, next) => {
  const token = request.cookies[authCookieName]
  if (!token) return response.status(401).json({ error: 'Sign in to continue.' })
  try {
    const payload = jwt.verify(token, process.env.AUTH_TOKEN_SECRET)
    request.userId = payload.sub
    next()
  } catch {
    response.clearCookie(authCookieName, authCookieOptions)
    response.status(401).json({ error: 'Your session has expired. Please sign in again.' })
  }
}

const requireAdmin = (request, response, next) => {
  const token = request.cookies[adminCookieName]
  if (!token) return response.status(401).json({ error: 'Admin sign-in is required.' })
  try {
    const payload = jwt.verify(token, process.env.AUTH_TOKEN_SECRET)
    if (payload.role !== 'admin') throw new Error('Invalid admin session.')
    next()
  } catch {
    response.clearCookie(adminCookieName, adminCookieOptions)
    response.status(401).json({ error: 'Your admin session has expired. Please sign in again.' })
  }
}

const findNextAvailable = async (location, requestedStart, durationHours) => {
  const limit = new Date(requestedStart.getTime() + 90 * 24 * 60 * 60 * 1000)
  const bookings = await Booking.find({
    location,
    status: 'confirmed',
    endAt: { $gt: requestedStart },
    startAt: { $lt: limit },
  }).sort({ startAt: 1 }).select('startAt endAt').lean()

  let candidate = new Date(requestedStart)
  const durationMs = durationHours * 60 * 60 * 1000
  for (const booking of bookings) {
    if (booking.endAt <= candidate) continue
    if (booking.startAt >= candidate && booking.startAt.getTime() - candidate.getTime() >= durationMs) break
    if (booking.startAt.getTime() < candidate.getTime() + durationMs && booking.endAt > candidate) {
      candidate = new Date(booking.endAt)
    }
  }
  if (candidate.getTime() + durationMs > limit.getTime()) return null

  const waitMinutes = Math.max(0, Math.ceil((candidate - requestedStart) / 60000))
  return {
    startAt: candidate,
    date: formatIndiaDate(candidate),
    startTime: formatIndiaTime(candidate),
    waitMinutes,
  }
}

const validateBooking = (body) => {
  const { location, date, startTime, durationHours, game, paymentMethod } = body
  if (!LOCATIONS.includes(location)) return 'Choose a valid Coimbatore-area location.'
  if (!GAMES.includes(game)) return 'Choose a valid game.'
  if (!['cash', 'razorpay'].includes(paymentMethod)) return 'Choose cash or online payment.'
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Enter a valid date.'
  if (typeof startTime !== 'string' || !/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(startTime)) {
    return 'Choose a start time in 15-minute increments.'
  }
  if (!Number.isInteger(Number(durationHours)) || Number(durationHours) < 1 || Number(durationHours) > 12) {
    return 'Booking duration must be between 1 and 12 whole hours.'
  }
  const startAt = parseLocalDateTime(date, startTime)
  if (Number.isNaN(startAt.getTime()) || formatIndiaDate(startAt) !== date || formatIndiaTime(startAt) !== startTime) {
    return 'Enter a valid local date and time.'
  }
  if (startAt <= new Date()) return 'Choose a future start time.'
  return null
}

app.get('/api/health', (_request, response) => {
  const status = databaseReady ? 200 : 503
  response.status(status).json({
    status: databaseReady ? 'ok' : 'unavailable',
    database: databaseReady ? 'connected' : 'disconnected',
    error: databaseReady ? undefined : 'MongoDB Atlas is not connected. Configure MONGODB_URI in .env.',
  })
})

app.get('/api/payment-options', (_request, response) => {
  response.json({
    hourlyRateInr,
    enabled: razorpayConfigured,
    keyId: razorpayConfigured ? razorpayKeyId : '',
  })
})

app.post('/api/admin/login', async (request, response) => {
  if (!adminEmail || !adminPasswordHash) {
    return response.status(503).json({ error: 'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env.' })
  }
  const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : ''
  const password = typeof request.body.password === 'string' ? request.body.password : ''
  const passwordMatches = await bcrypt.compare(password, await adminPasswordHash)
  if (email !== adminEmail || !passwordMatches) {
    return response.status(401).json({ error: 'The admin email or password is incorrect.' })
  }
  const token = jwt.sign({ role: 'admin' }, process.env.AUTH_TOKEN_SECRET, { expiresIn: '8h' })
  response.cookie(adminCookieName, token, adminCookieOptions)
  response.json({ admin: { email: adminEmail } })
})

app.post('/api/admin/logout', (_request, response) => {
  response.clearCookie(adminCookieName, adminCookieOptions)
  response.json({ ok: true })
})

app.use('/api', (_request, response, next) => {
  if (!databaseReady) {
    return response.status(503).json({
      error: 'Booking database is unavailable. Configure MONGODB_URI and ensure Atlas is reachable.',
    })
  }
  next()
})

app.get('/api/admin/session', (request, response) => {
  const token = request.cookies[adminCookieName]
  if (!token) return response.json({ admin: null })
  try {
    const payload = jwt.verify(token, process.env.AUTH_TOKEN_SECRET)
    if (payload.role !== 'admin') throw new Error('Invalid admin session.')
    return response.json({ admin: { email: adminEmail }, hourlyRateInr })
  } catch {
    response.clearCookie(adminCookieName, adminCookieOptions)
    return response.json({ admin: null })
  }
})

app.get('/api/admin/bookings', requireAdmin, async (_request, response, next) => {
  try {
    const bookings = await Booking.find({}).sort({ startAt: -1 }).limit(250).lean()
    response.json({ bookings: bookings.map(serializeBooking) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/admin/analytics', requireAdmin, async (_request, response, next) => {
  try {
    const now = new Date()
    const monthParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now).map(({ type, value }) => [type, value]))
    const currentYear = Number(monthParts.year)
    const currentMonth = Number(monthParts.month)
    const firstMonth = new Date(Date.UTC(currentYear, currentMonth - 6, 1) - 330 * 60 * 1000)
    const [summaryRows, monthRows] = await Promise.all([
      Booking.aggregate([
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            confirmedBookings: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0] } },
            cancelledBookings: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            paidBookings: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, 1, 0] } },
            collectedRevenueInr: {
              $sum: {
                $cond: [
                  { $eq: ['$paymentStatus', 'paid'] },
                  { $ifNull: ['$totalAmountInr', 0] },
                  0,
                ],
              },
            },
          },
        },
      ]),
      Booking.aggregate([
        { $match: { createdAt: { $gte: firstMonth } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } },
            bookings: { $sum: 1 },
            collectedRevenueInr: {
              $sum: {
                $cond: [
                  { $eq: ['$paymentStatus', 'paid'] },
                  { $ifNull: ['$totalAmountInr', 0] },
                  0,
                ],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ])
    const summary = summaryRows[0] || {
      totalBookings: 0,
      confirmedBookings: 0,
      cancelledBookings: 0,
      paidBookings: 0,
      collectedRevenueInr: 0,
    }
    const monthMap = new Map(monthRows.map((month) => [month._id, month]))
    const monthly = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(Date.UTC(currentYear, currentMonth - 6 + index, 1))
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
      const month = monthMap.get(key)
      return {
        month: key,
        bookings: month?.bookings || 0,
        collectedRevenueInr: month?.collectedRevenueInr || 0,
      }
    })
    response.json({ ...summary, monthly })
  } catch (error) {
    next(error)
  }
})

app.get('/api/reviews', async (_request, response, next) => {
  try {
    const [reviews, summaryRows, locationRatingRows] = await Promise.all([
      Review.find({}).sort({ createdAt: -1 }).limit(8).lean(),
      Review.aggregate([
        { $group: { _id: null, averageRating: { $avg: '$rating' }, reviewCount: { $sum: 1 } } },
      ]),
      Review.aggregate([
        {
          $lookup: {
            from: Booking.collection.name,
            localField: 'bookingId',
            foreignField: '_id',
            as: 'booking',
          },
        },
        { $unwind: '$booking' },
        {
          $group: {
            _id: '$booking.location',
            averageRating: { $avg: '$rating' },
            reviewCount: { $sum: 1 },
          },
        },
      ]),
    ])
    const summary = summaryRows[0] || { averageRating: 0, reviewCount: 0 }
    response.json({
      averageRating: Number(summary.averageRating.toFixed(1)),
      reviewCount: summary.reviewCount,
      reviews: reviews.map(serializeReview),
      locationRatings: Object.fromEntries(locationRatingRows.map((rating) => [
        rating._id,
        { averageRating: Number(rating.averageRating.toFixed(1)), reviewCount: rating.reviewCount },
      ])),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/reviews', requireAuth, async (request, response, next) => {
  try {
    const { bookingId, rating, comment = '' } = request.body
    if (!mongoose.isValidObjectId(bookingId)) {
      return response.status(400).json({ error: 'Choose a valid booking to review.' })
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return response.status(400).json({ error: 'Choose a rating from 1 to 5 stars.' })
    }
    if (typeof comment !== 'string' || comment.trim().length > 500) {
      return response.status(400).json({ error: 'Review comments must be 500 characters or fewer.' })
    }
    const booking = await Booking.findOne({
      _id: bookingId,
      userId: request.userId,
      status: 'confirmed',
      endAt: { $lte: new Date() },
    }).lean()
    if (!booking) {
      return response.status(403).json({ error: 'You can review this booking after it has finished.' })
    }
    const existingReview = await Review.exists({ bookingId: booking._id })
    if (existingReview) return response.status(409).json({ error: 'You have already reviewed this booking.' })
    const review = await Review.create({
      bookingId: booking._id,
      userId: request.userId,
      customerName: booking.contactName.split(/\s+/)[0],
      rating,
      comment: comment.trim(),
    })
    response.status(201).json({ review: serializeReview(review) })
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: 'You have already reviewed this booking.' })
    next(error)
  }
})

app.patch('/api/admin/bookings/:bookingId/cancel', requireAdmin, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.bookingId)) {
      return response.status(400).json({ error: 'Invalid booking reference.' })
    }
    const result = await cancelBooking({ bookingId: request.params.bookingId })
    if (result.error) return response.status(result.status).json({ error: result.error })
    response.json({ booking: result.booking })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/admin/settings/hourly-rate', requireAdmin, async (request, response, next) => {
  try {
    const rate = request.body.hourlyRateInr
    if (!Number.isSafeInteger(rate) || rate < 1 || rate > 1000000) {
      return response.status(400).json({ error: 'Hourly rate must be a whole number between ₹1 and ₹1,000,000.' })
    }
    await Settings.findByIdAndUpdate(
      'platform',
      { $set: { hourlyRateInr: rate } },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
    )
    hourlyRateInr = rate
    response.json({ hourlyRateInr })
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/register', async (request, response, next) => {
  try {
    const { name, email, phone, password } = request.body
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
      return response.status(400).json({ error: 'Enter your name (2–80 characters).' })
    }
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return response.status(400).json({ error: 'Enter a valid email address.' })
    }
    if (typeof phone !== 'string' || !/^\+?[0-9\s()-]{10,20}$/.test(phone.trim()) || phone.replace(/\D/g, '').length < 10) {
      return response.status(400).json({ error: 'Enter a valid phone number with at least 10 digits.' })
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return response.status(400).json({ error: 'Password must be between 8 and 72 characters.' })
    }
    const normalizedEmail = email.trim().toLowerCase()
    const existingUser = await User.exists({ email: normalizedEmail })
    if (existingUser) return response.status(409).json({ error: 'An account with this email already exists.' })

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone.trim(),
      passwordHash,
    })
    signIn(response, user)
    response.status(201).json({ user: serializeUser(user) })
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ error: 'An account with this email already exists.' })
    next(error)
  }
})

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const { email, password } = request.body
    if (typeof email !== 'string' || typeof password !== 'string') {
      return response.status(400).json({ error: 'Enter your email and password.' })
    }
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash')
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return response.status(401).json({ error: 'Email or password is incorrect.' })
    }
    signIn(response, user)
    response.json({ user: serializeUser(user) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/logout', (_request, response) => {
  response.clearCookie(authCookieName, authCookieOptions)
  response.json({ ok: true })
})

app.get('/api/auth/me', async (request, response, next) => {
  const token = request.cookies[authCookieName]
  if (!token) return response.json({ user: null })
  let payload
  try {
    payload = jwt.verify(token, process.env.AUTH_TOKEN_SECRET)
  } catch {
    response.clearCookie(authCookieName, authCookieOptions)
    return response.json({ user: null })
  }
  try {
    const user = await User.findById(payload.sub)
    if (!user) return response.json({ user: null })
    response.json({ user: serializeUser(user) })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/auth/profile', requireAuth, async (request, response, next) => {
  try {
    const { name, phone } = request.body
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
      return response.status(400).json({ error: 'Enter your name (2–80 characters).' })
    }
    if (typeof phone !== 'string' || !/^\+?[0-9\s()-]{10,20}$/.test(phone.trim()) || phone.replace(/\D/g, '').length < 10) {
      return response.status(400).json({ error: 'Enter a valid phone number with at least 10 digits.' })
    }
    const user = await User.findByIdAndUpdate(
      request.userId,
      { $set: { name: name.trim(), phone: phone.trim() } },
      { returnDocument: 'after', runValidators: true },
    )
    if (!user) return response.status(404).json({ error: 'Your account is unavailable. Please sign in again.' })
    response.json({ user: serializeUser(user) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/my-bookings', requireAuth, async (request, response, next) => {
  try {
    const [bookings, reviews] = await Promise.all([
      Booking.find({ userId: request.userId }).sort({ startAt: -1 }).lean(),
      Review.find({ userId: request.userId }).lean(),
    ])
    const reviewByBookingId = new Map(reviews.map((review) => [review.bookingId.toString(), serializeReview(review)]))
    response.json({
      bookings: bookings.map((booking) => ({
        ...serializeBooking(booking),
        review: reviewByBookingId.get(booking._id.toString()) || null,
      })),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/my-bookings/:bookingId/verify-payment', requireAuth, async (request, response) => {
  try {
    if (!razorpayConfigured) {
      return response.status(503).json({ error: 'Online payment is not configured. Please choose cash or contact the turf.' })
    }
    if (!mongoose.isValidObjectId(request.params.bookingId)) {
      return response.status(400).json({ error: 'Invalid booking reference.' })
    }
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = request.body
    if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') {
      return response.status(400).json({ error: 'Razorpay returned incomplete payment details.' })
    }
    const booking = await Booking.findOne({
      _id: request.params.bookingId,
      userId: request.userId,
      status: 'confirmed',
      paymentMethod: 'razorpay',
    })
    if (!booking || booking.razorpayOrderId !== orderId) {
      return response.status(404).json({ error: 'The matching online payment booking was not found.' })
    }
    if (booking.paymentStatus === 'paid') {
      return response.json({ booking: serializeBooking(booking) })
    }
    const expectedSignature = createHmac('sha256', razorpayKeySecret)
      .update(`${orderId}|${paymentId}`)
      .digest()
    let receivedSignature
    try {
      receivedSignature = Buffer.from(signature, 'hex')
    } catch {
      return response.status(400).json({ error: 'Invalid Razorpay payment signature.' })
    }
    if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(receivedSignature, expectedSignature)) {
      return response.status(400).json({ error: 'Razorpay payment signature could not be verified.' })
    }

    let payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`)
    if (
      payment.order_id !== orderId ||
      payment.amount !== booking.totalAmountInr * 100 ||
      payment.currency !== 'INR'
    ) {
      return response.status(400).json({ error: 'The Razorpay payment does not match this booking amount.' })
    }
    if (payment.status === 'authorized') {
      try {
        payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}/capture`, {
          method: 'POST',
          body: { amount: booking.totalAmountInr * 100, currency: 'INR' },
        })
      } catch (error) {
        console.error('Could not capture Razorpay payment:', error.message)
        payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`)
      }
    }
    if (payment.status !== 'captured') {
      return response.status(202).json({
        message: 'Razorpay has not confirmed the payment capture yet. Check My Bookings and try again.',
        booking: serializeBooking(booking),
      })
    }
    booking.paymentStatus = 'paid'
    booking.paymentId = paymentId
    await booking.save()
    response.json({ booking: serializeBooking(booking) })
  } catch (error) {
    console.error('Could not verify Razorpay payment:', error.message)
    response.status(502).json({ error: 'Could not verify the payment with Razorpay. Please retry from My Bookings.' })
  }
})

app.delete('/api/my-bookings/:bookingId', requireAuth, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.bookingId)) {
      return response.status(400).json({ error: 'Invalid booking reference.' })
    }
    const result = await cancelBooking({ bookingId: request.params.bookingId, userId: request.userId })
    if (result.error) return response.status(result.status).json({ error: result.error })
    response.json({ booking: result.booking })
  } catch (error) {
    next(error)
  }
})

app.get('/api/bookings', async (request, response, next) => {
  try {
    const { location, date } = request.query
    if (!LOCATIONS.includes(location)) return response.status(400).json({ error: 'Choose a valid Coimbatore-area location.' })
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return response.status(400).json({ error: 'Enter a valid date.' })
    }
    const dayStart = parseLocalDateTime(date, '00:00')
    if (formatIndiaDate(dayStart) !== date) return response.status(400).json({ error: 'Enter a valid date.' })
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
    const bookings = await Booking.find({
      location,
      status: 'confirmed',
      startAt: { $lt: dayEnd },
      endAt: { $gt: dayStart },
    }).sort({ startAt: 1 }).lean()
    response.json({ bookings: bookings.map(serializeAvailability) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/bookings', requireAuth, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.userId)) {
      return response.status(401).json({ error: 'Sign in to book a pitch.' })
    }
    const user = await User.findById(request.userId)
    if (!user) return response.status(401).json({ error: 'Your account is unavailable. Please sign in again.' })
    const validationError = validateBooking(request.body)
    if (validationError) return response.status(400).json({ error: validationError })
    if (request.body.paymentMethod === 'razorpay' && !razorpayConfigured) {
      return response.status(503).json({ error: 'Online payment is not configured. Ask the project owner to add Razorpay test or live API keys.' })
    }

    const { location, game, date, startTime, paymentMethod } = request.body
    const durationHours = Number(request.body.durationHours)
    const startAt = parseLocalDateTime(date, startTime)
    const endAt = new Date(startAt.getTime() + durationHours * 60 * 60 * 1000)
    const conflictingBooking = await Booking.findOne({
      location,
      status: 'confirmed',
      startAt: { $lt: endAt },
      endAt: { $gt: startAt },
    }).sort({ endAt: -1 }).lean()

    if (conflictingBooking) {
      const nextAvailable = await findNextAvailable(location, startAt, durationHours)
      return response.status(409).json({
        error: 'That location is occupied during the requested time.',
        message: `Another ${conflictingBooking.game} booking overlaps this time (${formatIndiaTime(conflictingBooking.startAt)}–${formatIndiaTime(conflictingBooking.endAt)}).`,
        waitMinutes: nextAvailable?.waitMinutes ?? null,
        nextAvailable,
      })
    }

    const bookingId = new mongoose.Types.ObjectId()
    const reference = randomUUID().slice(0, 8).toUpperCase()
    const totalAmountInr = hourlyRateInr * durationHours
    let razorpayOrderId = ''
    if (paymentMethod === 'razorpay') {
      try {
        const order = await razorpayRequest('/orders', {
          method: 'POST',
          body: {
            amount: totalAmountInr * 100,
            currency: 'INR',
            receipt: reference,
            notes: { bookingId: bookingId.toString(), userId: user._id.toString() },
          },
        })
        razorpayOrderId = order.id
      } catch (error) {
        console.error('Could not create Razorpay order:', error.message)
        return response.status(502).json({ error: `Could not start Razorpay Checkout: ${error.message}` })
      }
    }
    const booking = await Booking.create({
      _id: bookingId,
      userId: user._id,
      contactName: user.name,
      contactEmail: user.email,
      contactPhone: user.phone,
      location,
      game,
      startAt,
      endAt,
      durationHours,
      paymentMethod,
      paymentStatus: paymentMethod === 'cash' ? 'cash_due' : 'pending',
      totalAmountInr,
      razorpayOrderId,
      reference,
    })
    const slotCount = durationHours * 60 / slotMinutes
    const slots = Array.from({ length: slotCount }, (_, index) => ({
      location,
      startsAt: new Date(startAt.getTime() + index * slotMinutes * 60 * 1000),
      bookingId,
    }))

    try {
      await Slot.insertMany(slots, { ordered: true })
    } catch (error) {
      await Slot.deleteMany({ bookingId })
      await Booking.deleteOne({ _id: bookingId })
      if (error.code !== 11000) throw error

      const nextAvailable = await findNextAvailable(location, startAt, durationHours)
      return response.status(409).json({
        error: 'That location was just booked by someone else.',
        message: 'Another player confirmed this time moments ago.',
        waitMinutes: nextAvailable?.waitMinutes ?? null,
        nextAvailable,
      })
    }

    response.status(201).json({
      booking: serializeBooking(booking),
      payment: paymentMethod === 'razorpay' ? {
        keyId: razorpayKeyId,
        orderId: razorpayOrderId,
        amount: totalAmountInr * 100,
        currency: 'INR',
      } : null,
    })
  } catch (error) {
    next(error)
  }
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ error: 'An unexpected server error occurred. Please try again.' })
})

const start = async () => {
  if (!process.env.AUTH_TOKEN_SECRET || process.env.AUTH_TOKEN_SECRET.length < 32) {
    throw new Error('AUTH_TOKEN_SECRET must be set to a random secret of at least 32 characters in .env.')
  }
  if (!Number.isSafeInteger(hourlyRateInr) || hourlyRateInr < 1) {
    throw new Error('TURF_HOURLY_RATE_INR must be a positive whole number.')
  }
  if (Boolean(adminEmail) !== Boolean(adminPassword)) {
    throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD in .env to enable admin login.')
  }
  if (adminEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminPassword.length < 8 || adminPassword.length > 72)) {
    throw new Error('ADMIN_EMAIL must be valid and ADMIN_PASSWORD must be 8–72 characters.')
  }
  app.listen(port, () => console.log(`Booking API listening on http://localhost:${port}`))
  if (!process.env.MONGODB_URI) {
    console.error('MongoDB Atlas is not configured. Add MONGODB_URI to .env; booking requests will return HTTP 503.')
    return
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 20000,
    })
    await User.init()
    await Booking.init()
    await Slot.init()
    await Review.init()
    await reconcileBookingSlots()
    const settings = await Settings.findById('platform').lean()
    if (settings) hourlyRateInr = settings.hourlyRateInr
    databaseReady = true
    console.log('Connected to MongoDB Atlas and initialized the booking-slot index.')
  } catch (error) {
    console.error('Could not connect to MongoDB Atlas:', error.message)
  }
}

start().catch((error) => {
  console.error('Could not start the booking API:', error)
  process.exitCode = 1
})
