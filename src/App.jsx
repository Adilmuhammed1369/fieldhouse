import { useEffect, useState } from 'react'
import './App.css'

const locations = ['Pollachi', 'Kinathukadavu', 'Eachanari', 'Malumichampatti', 'Ukkadam', 'Kovaipudur', 'Sulur', 'Singanallur', 'Gandhipuram', 'Vadavalli', 'Thudiyalur']
const games = ['Cricket', 'Football', '5-a-side football', '7-a-side football', 'Badminton']
const api = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'Request failed.')
  return body
}
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`
const prettyDate = (value) => new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
const prettyTime = (value) => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })

function AuthForm({ mode, onSuccess, onSwitch }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' })
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault(); setError('')
    try { const result = await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(form) }); onSuccess(result.user) } catch (err) { setError(err.message) }
  }
  return <form className="panel auth-form" onSubmit={submit}>
    <h2>{mode === 'login' ? 'Welcome back.' : 'Create your player account.'}</h2>
    {mode === 'register' && <><label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Phone<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label></>}
    <label>Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
    <label>Password<input type="password" required minLength="8" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
    {error && <p className="error">{error}</p>}<button className="primary">{mode === 'login' ? 'Sign in' : 'Register'}</button>
    <button type="button" className="link-button" onClick={onSwitch}>{mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}</button>
  </form>
}

function BookingPanel({ user, onAuth, onRefresh }) {
  const [form, setForm] = useState({ location: locations[0], game: games[0], date: today(), startTime: '18:00', durationHours: 1, paymentMethod: 'cash' })
  const [bookings, setBookings] = useState([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [rate, setRate] = useState(500)
  const update = (key, value) => setForm({ ...form, [key]: value })
  useEffect(() => { api('/payment-options').then((data) => { setRate(data.hourlyRateInr) }).catch(() => {}) }, [])
  useEffect(() => { api(`/bookings?location=${encodeURIComponent(form.location)}&date=${form.date}`).then((data) => setBookings(data.bookings)).catch(() => setBookings([])) }, [form.location, form.date])
  const submit = async (event) => {
    event.preventDefault(); setError(''); setMessage('')
    if (!user) { onAuth('login'); return }
    try {
      const result = await api('/bookings', { method: 'POST', body: JSON.stringify(form) })
      if (result.payment) {
        if (!window.Razorpay) throw new Error('Razorpay Checkout is unavailable. Please refresh and try again.')
        const checkout = new window.Razorpay({ key: result.payment.keyId, amount: result.payment.amount, currency: result.payment.currency, name: 'Fieldhouse', description: `${form.game} at ${form.location}`, order_id: result.payment.orderId, prefill: { name: user.name, email: user.email, contact: user.phone }, handler: async (payment) => {
          try { await api(`/my-bookings/${result.booking.id}/verify-payment`, { method: 'POST', body: JSON.stringify(payment) }); setMessage('Payment confirmed. Your pitch is booked.'); onRefresh() } catch (err) { setError(err.message) }
        } })
        checkout.open()
      } else { setMessage(`Booking confirmed. Reference: ${result.booking.reference}`); onRefresh() }
    } catch (err) { setError(err.message) }
  }
  return <section className="booking-area panel" id="book">
    <div><p className="eyebrow dark">COIMBATORE & POLLACHI</p><h2>Book your <em>perfect pitch.</em></h2><p>Choose a local venue, time and game. Slots are locked in 15-minute intervals.</p></div>
    <form className="booking-grid" onSubmit={submit}>
      <label>Location<select value={form.location} onChange={(e) => update('location', e.target.value)}>{locations.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>Game<select value={form.game} onChange={(e) => update('game', e.target.value)}>{games.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>Date<input type="date" min={today()} value={form.date} onChange={(e) => update('date', e.target.value)} /></label>
      <label>Start time<input type="time" step="900" value={form.startTime} onChange={(e) => update('startTime', e.target.value)} /></label>
      <label>Duration<select value={form.durationHours} onChange={(e) => update('durationHours', Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} hour{i ? 's' : ''}</option>)}</select></label>
      <label>Payment<select value={form.paymentMethod} onChange={(e) => update('paymentMethod', e.target.value)}><option value="cash">Pay at the turf</option><option value="razorpay">Razorpay (UPI / card)</option></select></label>
      <p className="price">Total: <strong>{money(rate * form.durationHours)}</strong></p>
      {error && <p className="error full">{error}</p>}{message && <p className="success full">{message}</p>}
      <button className="primary full"> {user ? 'Confirm booking' : 'Sign in to book'} <span>→</span></button>
    </form>
    <div className="availability"><h3>Confirmed times on {form.date}</h3>{bookings.length ? bookings.map((item) => <p key={item.id}><strong>{item.game}</strong> · {prettyTime(item.startAt)}–{prettyTime(item.endAt)} · {item.id.slice(-8).toUpperCase()}</p>) : <p>No bookings yet for this date.</p>}</div>
  </section>
}

function Account({ user, onRefresh }) {
  const [bookings, setBookings] = useState([]); const [error, setError] = useState('')
  const load = () => api('/my-bookings').then((data) => setBookings(data.bookings)).catch((err) => setError(err.message))
  useEffect(load, [])
  const cancel = async (id) => { if (!window.confirm('Cancel this booking?')) return; try { await api(`/my-bookings/${id}`, { method: 'DELETE' }); load(); onRefresh() } catch (err) { setError(err.message) } }
  const review = async (bookingId, rating, comment) => { try { await api('/reviews', { method: 'POST', body: JSON.stringify({ bookingId, rating, comment }) }); load() } catch (err) { setError(err.message) } }
  return <section className="panel account"><h2>{user.name}'s bookings</h2><p>{user.email} · {user.phone}</p>{error && <p className="error">{error}</p>}{bookings.map((item) => <article className="booking-card" key={item.id}><div><strong>{item.reference}</strong><p>{item.game} · {item.location}</p><p>{prettyDate(item.startAt)} · {item.durationHours} hour(s)</p></div><div><b>{money(item.totalAmountInr)}</b><small>{item.paymentStatus} · {item.status}</small>{item.status === 'confirmed' && new Date(item.startAt) > new Date() && <button className="danger" onClick={() => cancel(item.id)}>Cancel</button>}{item.status === 'confirmed' && new Date(item.endAt) <= new Date() && !item.review && <ReviewForm booking={item} onSubmit={review} />}{item.review && <small className="reviewed">Reviewed: {'★'.repeat(item.review.rating)}</small>}</div></article>)}{!bookings.length && <p>No bookings yet. Choose a pitch above.</p>}</section>
}

function ReviewForm({ booking, onSubmit }) {
  const [rating, setRating] = useState(5); const [comment, setComment] = useState('')
  const submit = async (event) => { event.preventDefault(); await onSubmit(booking.id, rating, comment); setComment('') }
  return <form className="review-form" onSubmit={submit}><label>Rate your match<select value={rating} onChange={(event) => setRating(Number(event.target.value))}><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select></label><input maxLength="500" placeholder="Share your experience" value={comment} onChange={(event) => setComment(event.target.value)} /><button className="link-button">Post review</button></form>
}

function Reviews() {
  const [data, setData] = useState({ averageRating: 0, reviewCount: 0, reviews: [] })
  useEffect(() => { api('/reviews').then(setData).catch(() => {}) }, [])
  return <section className="reviews-section" id="reviews"><div><p className="eyebrow dark">PLAYER REVIEWS</p><h2>Good games.<br /><em>Great company.</em></h2><p className="review-summary">{data.averageRating ? `${data.averageRating}/5 from ${data.reviewCount} player reviews` : 'Be the first player to share your experience.'}</p></div><div className="review-list">{data.reviews.map((review) => <article className="review-card" key={review.id}><strong>{review.customerName}</strong><span className="stars">{'★'.repeat(review.rating)}</span><p>{review.comment || 'A great match at Fieldhouse.'}</p></article>)}</div></section>
}

function Admin() {
  const [admin, setAdmin] = useState(null); const [form, setForm] = useState({ email: '', password: '' }); const [bookings, setBookings] = useState([]); const [analytics, setAnalytics] = useState(null); const [error, setError] = useState('')
  const load = async () => { try { const session = await api('/admin/session'); if (!session.admin) return; setAdmin(session.admin); const [list, stats] = await Promise.all([api('/admin/bookings'), api('/admin/analytics')]); setBookings(list.bookings); setAnalytics(stats) } catch (err) { setError(err.message) } }
  useEffect(() => { load() }, [])
  const login = async (e) => { e.preventDefault(); try { await api('/admin/login', { method: 'POST', body: JSON.stringify(form) }); load() } catch (err) { setError(err.message) } }
  if (!admin) return <form className="panel auth-form" onSubmit={login}><h2>Admin dashboard</h2><label>Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Password<input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>{error && <p className="error">{error}</p>}<button className="primary">Sign in as admin</button></form>
  const cancel = async (id) => { try { await api(`/admin/bookings/${id}/cancel`, { method: 'PATCH' }); load() } catch (err) { setError(err.message) } }
  return <section className="panel account"><h2>Admin dashboard</h2>{analytics && <div className="stat-grid admin-stats"><div><strong>{analytics.totalBookings}</strong><span>Total bookings</span></div><div><strong>{analytics.cancelledBookings}</strong><span>Cancelled</span></div><div><strong>{money(analytics.collectedRevenueInr)}</strong><span>Collected revenue</span></div></div>}{error && <p className="error">{error}</p>}<h3>Latest bookings</h3>{bookings.map((item) => <article className="booking-card" key={item.id}><div><strong>{item.reference}</strong><p>{item.contactName} · {item.contactPhone}</p><p>{item.location} · {item.game} · {prettyDate(item.startAt)}</p></div><div><span>{item.status}</span>{item.status === 'confirmed' && <button className="danger" onClick={() => cancel(item.id)}>Cancel</button>}</div></article>)}</section>
}

function App() {
  const [user, setUser] = useState(null); const [view, setView] = useState(window.location.pathname === '/admin' ? 'admin' : 'home'); const [auth, setAuth] = useState(null)
  const refresh = () => api('/auth/me').then((data) => setUser(data.user)).catch(() => setUser(null))
  useEffect(() => { refresh(); const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.async = true; document.body.appendChild(script); return () => script.remove() }, [])
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); setView('home') }
  return <main><section className="hero" id="home"><nav className="nav shell"><a className="brand" href="#home"><span className="brand-mark">F</span><span>fieldhouse</span></a><div className="nav-links"><a href="#book">Book a pitch</a><a href="#reviews">Reviews</a>{user ? <><button className="nav-button" onClick={() => setView('account')}>My bookings</button><button className="nav-button" onClick={logout}>Log out</button></> : <button className="nav-button" onClick={() => setAuth('login')}>Sign in</button>}</div></nav><div className="hero-content shell"><p className="eyebrow">COIMBATORE'S HOME OF YOUR GAME <span></span> EST. 2018</p><h1>Your next<br /><em>match</em> starts here.</h1><p className="hero-copy">Premium pitches across Coimbatore and Pollachi.<br />Easy booking. More time playing.</p><a className="round-arrow" href="#book">↘</a></div></section><div className="content shell">{view === 'admin' ? <Admin /> : view === 'account' && user ? <Account user={user} onRefresh={refresh} /> : <><BookingPanel user={user} onAuth={setAuth} onRefresh={refresh} /><section className="numbers-section" id="community"><p className="eyebrow dark">THE FIELDHOUSE STANDARD</p><h2>Made for <em>the beautiful game.</em></h2><div className="stat-grid"><div><strong>11</strong><span>LOCAL AREAS</span></div><div><strong>4.9</strong><span>PLAYER RATING</span></div><div><strong>24/7</strong><span>ONLINE BOOKING</span></div></div></section><Reviews /></>}</div>{auth && <div className="modal"><button className="close" onClick={() => setAuth(null)}>×</button><AuthForm mode={auth} onSuccess={(account) => { setUser(account); setAuth(null) }} onSwitch={() => setAuth(auth === 'login' ? 'register' : 'login')} /></div>}</main>
}

export default App
