# Fieldhouse Turf Booking

A React/Vite booking page with an Express API and MongoDB Atlas persistence for turf bookings around Coimbatore, Tamil Nadu.

## Locations and games

The booking form includes Pollachi and nearby Coimbatore areas. Area discovery cards use illustrative sports photography, show verified review scores when available, and link directly to live availability. Cricket, football, 5-a-side football, 7-a-side football, and badminton are available.

## Configure MongoDB Atlas

1. Create a MongoDB Atlas cluster and database user.
2. Add your development machine's IP address to the Atlas Network Access allowlist.
3. Copy `.env.example` to `.env` and replace the `MONGODB_URI` value with your Atlas connection string. URL-encode special characters in the database user's password.
4. Keep `.env` private; it is excluded from Git.

The API creates its unique time-slot index when it starts. Bookings use 15-minute slot locks, so overlapping requests for the same location cannot both be confirmed, including when requests arrive concurrently. The booking form uses the browser's native date and time pickers; start times can be set in 15-minute increments. Confirmed bookings for the selected location and date are listed beneath the booking button, including game and time range. The API checks the selected location, date, time, and booking length before confirming a booking. Booking lengths are whole hours from 1 to 12. When a requested time is occupied, the API returns the first later time with enough room for the requested duration; the user must confirm the suggested time before it is booked.

## Accounts and booking management

Create an account with your name, email, phone number, and a password of at least 8 characters, or sign in to an existing account. Dedicated registration and sign-in pages are available at `/register` and `/login`; the booking page’s account section remains available as well. Passwords are hashed before storage. The API uses an HTTP-only, SameSite session cookie signed with `AUTH_TOKEN_SECRET`; use a long random secret and keep it private. Account holders can update their name and phone number; their sign-in email stays read-only. Each booking is associated with the signed-in account and stores its contact details. The account page summarizes total, upcoming, completed, and cancelled bookings, highlights the next match, and filters booking history by status. Players can download calendar events for upcoming confirmed bookings and copy any booking reference. They can review completed matches, cancel their own confirmed bookings before the start time, or prefill the booking form with the same pitch and time for its next future weekly occurrence. Rebooking never submits automatically; check availability and confirm the new booking yourself. Cancellation releases the reserved time slots.

## Admin dashboard

Open `/admin` to sign in to the separate admin dashboard. Configure `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the private `.env` file; use a unique password of 8–72 characters and keep both values private. Admin sessions use a separate HTTP-only cookie and expire after 8 hours. The dashboard lists the latest 250 bookings, supports searching and filtering, allows cancellation of confirmed unpaid bookings, and lets admins update the hourly price. Its analytics summarize all-time bookings and cancellations, collected revenue from bookings marked paid, and a six-month booking and revenue trend. Price changes are stored in MongoDB and apply only to new bookings. Captured Razorpay payments must be refunded from Razorpay before the related booking can be cancelled.

## Player reviews

Signed-in customers can leave one 1–5 star review, with an optional comment of up to 500 characters, after their confirmed booking has ended. Reviews are shown publicly on the home page using the customer’s first name only. Cancelled bookings and bookings belonging to another account cannot be reviewed.

Example setup:

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=use-a-unique-password-of-at-least-8-characters
```

## Payments

Choose cash at the turf or Razorpay Checkout when booking. The default rate is ₹500 per hour; set `TURF_HOURLY_RATE_INR` in `.env` to change it. Cash bookings are marked as payable at the turf.

To enable real online payments, create a Razorpay account and add its API key ID and secret to the private `.env` file as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Start with Razorpay test-mode keys (`rzp_test_...`) to test checkout without real charges. Use live-mode keys (`rzp_live_...`) only after the account is activated and ready to accept payments. Never expose the key secret in frontend code or commit it. Razorpay Checkout provides UPI, cards and netbanking as enabled for the merchant account. The API creates Razorpay orders, verifies Razorpay's payment signature server-side, and captures authorized payments before marking a booking paid. An unpaid online booking continues to reserve its time until the user pays or cancels it, so an active payment order cannot charge for a slot that has already been released. Online payment remains unavailable until valid Razorpay keys are configured. Razorpay may charge transaction fees; check the merchant account for current pricing.

## Run locally

Install dependencies with `npm install`, copy `.env.example` to `.env`, configure `MONGODB_URI`, and set `AUTH_TOKEN_SECRET` to a random secret at least 32 characters long. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to enable the admin dashboard. Configure `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to enable online payment, and optionally set the initial `TURF_HOURLY_RATE_INR`. Keep `.env` private; it is excluded from Git. Then use two terminals:

```sh
npm run dev:api
npm run dev
```

Open the Vite URL shown in the second terminal. Vite proxies `/api` requests to the Express server on port 4001. The API starts even before Atlas is configured and reports a clear HTTP 503 for booking requests until a valid, reachable `MONGODB_URI` is provided.

## Other commands

- `npm run build` creates the production frontend bundle.
- `npm run preview` serves the production frontend bundle.
- `npm run lint` runs Oxlint.
