# ParkEase

Parking reservation web app: **customers** reserve slots and pay online, **establishments** manage slots and see
their bookings, and an **admin** oversees users, establishments, commissions and reports.

**Stack:** plain HTML/CSS/JS front end (no framework, no build step beyond copying files) and a JSON API that
exists in two interchangeable forms:

| Form | Code | Database | Use it for |
|------|------|----------|------------|
| Netlify Function | `netlify/functions/` (Node 20) | Postgres (Netlify DB / Neon) | production on Netlify |
| Flask app | `app.py` (Python 3.10+) | SQLite | local development, tests |

Both implement the same routes and return the same JSON, so `pages/` and `public/` work with either.

## Quick start

### A. Deploy to Netlify
See [Deploying to Netlify](#deploying-to-netlify-everything-on-netlify) below. Short version: import the repo in
Netlify, add **Netlify DB** under Extensions, deploy.

### B. Run locally with Flask

```bash
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:5000>. The first start creates `instance/parkease.db` and fills it with demo data.
(Opening the HTML files directly or with VS Code Live Server does not work: login and data need the API.)

### C. Run locally the Netlify way (Function + Postgres)

```bash
npm install
npm i -g netlify-cli
netlify dev          # needs a Postgres URL: set DATABASE_URL in a .env file (see .env.example)
```

### Demo accounts

| Role          | Email                    | Password   |
|---------------|--------------------------|------------|
| Customer      | juan@email.com           | user123    |
| Customer      | maria@email.com          | user123    |
| Establishment | citywalk@parkease.com    | owner123   |
| Establishment | smtarlac@parkease.com    | owner123   |
| Admin         | admin@parkease.com       | admin123   |

**Change these passwords (or start with `PARKEASE_SEED_DEMO=0`) before putting the app online.**
Customers can sign up themselves ("Don't have an account yet?"). If someone forgets their password,
"Forgot Password?" on the login page e-mails them a reset link.

Reset the database any time with `python database.py --reset` (or `--empty` for no demo data).

## What each role can do

- **Customer** - pick a location, a slot, a date and arrival/departure times. *Reserve* checks the slot is
  free and shows the price; *Confirm* books it. Slots already taken for the chosen window are greyed out.
  *Slots Available* shows live counts per establishment. *Recent Activity* lists the customer's bookings.
- **Establishment** - *Overview* (revenue, reservations, slot states), *Parking Slots* (add, disable for
  maintenance, delete) and *Reservations* (all bookings with live status).
- **Admin** - *Dashboard* (total commission, users, establishments, per-establishment table), *Users* and
  *Establishments* (click a status to activate/deactivate), *Reports* (monthly summary, per-establishment
  totals, CSV export).

## Rules the app applies

- **Price** = hourly rate x hours, partial hours rounded **up** (2 h 30 min = 3 h). The rate and the
  admin's commission % are stored on each booking, so later rate changes don't alter old bookings.
- **Commission** = amount x the establishment's commission %. Cancelled bookings are ignored everywhere.
- **No double booking** - a slot can't be booked for an overlapping time (checked inside a locked database
  transaction). Back-to-back bookings are fine.
- Bookings must be at least 30 minutes, start in the future (max 60 days ahead) and end on the same day.
- **Reservation status** is derived from the clock: Incoming -> Ongoing -> Completed (or Cancelled).
- **Slot state** right now: *Occupied* (booking in progress), *Reserved* (a booking starts within 24 h),
  *Maintenance* (disabled), otherwise *Available*.
- On the establishment Overview, "Incoming" counts every booking not yet finished (upcoming + in progress),
  so Incoming + Completed = Total Reservations.
- Deactivated users can't log in (and are logged out immediately); deactivated establishments disappear
  from the customer pages.

## Project layout

```
pages/                  HTML pages
public/                 Styles/  Images/  Fonts/  js/   (static files)
build.mjs               Netlify build: pages/ + public/ -> dist/
netlify.toml            Netlify build + functions settings
netlify/functions/
  api.mjs               the whole API as one Netlify Function (routes, validation, business rules)
  lib/                  db (schema + demo data), security (scrypt, signed cookies), payments, mailer, util
tests-js/               npm test             (helpers: time, validation, passwords, sessions, webhooks)
app.py database.py payments.py mailer.py
                        Flask + SQLite version of the same API (local development)
tests/                  python -m unittest discover -s tests -v   (48 API tests against the Flask version)
.env.example            every environment variable, with comments
.github/workflows/      CI: runs both test suites on every push / pull request
```

Settings (environment variables, all optional): `PORT`, `HOST`, `PARKEASE_DB`, `PARKEASE_TZ`
(default `Asia/Manila`), `PARKEASE_SECRET_KEY`, `PARKEASE_HTTPS=1` (secure cookies behind HTTPS),
`PARKEASE_SEED_DEMO=0` (don't create demo data), `FLASK_DEBUG=1`.

## Security notes

Passwords are hashed; sessions use HttpOnly/SameSite cookies; every query is parameterised; all data is
inserted into pages as text (no HTML injection); state-changing API calls need a custom header
(CSRF protection); roles are enforced on the server; login is rate-limited (5 failures / 5 min).
For real deployment, run behind a production server (e.g. `gunicorn app:app`) over HTTPS.


## Payments (PayMongo: GCash, Maya, cards)

Pressing **Pay Now** holds the slot for 20 minutes and sends the customer to a PayMongo-hosted checkout page, so
card / wallet details never touch this server. The booking is created only after the app asks PayMongo whether the
session was really paid (the return URL alone proves nothing). If the slot was taken while the customer was paying
(e.g. they paid after the hold expired) the payment is refunded automatically.

| Variable | Purpose |
|----------|---------|
| `PAYMONGO_SECRET_KEY` | `sk_test_...` for PayMongo test mode, `sk_live_...` for real money. **Without it the app uses a fake "TEST MODE" checkout page and no money moves.** |
| `PAYMONGO_METHODS` | default `gcash,paymaya,card` (only methods enabled on your PayMongo account will work) |
| `PAYMONGO_WEBHOOK_SECRET` | optional: register `https://your-site/webhooks/paymongo` for the `checkout_session.payment.paid` event so a payment is confirmed even if the customer closes the browser before returning |
| `PARKEASE_BASE_URL` | your public address, e.g. `https://parkease.example.com` (used in payment return links and e-mails) |

With `PARKEASE_HTTPS=1` the app refuses to start without `PAYMONGO_SECRET_KEY`, so the fake checkout can't go live by accident.

## Cancelling a booking

Customers cancel from **My Bookings** before the arrival time. Cancelling at least `PARKEASE_REFUND_HOURS`
(default **2**) before arrival refunds the full amount through PayMongo; a later cancellation is allowed but not
refunded. If PayMongo rejects the refund the booking stays active so the customer can retry. Cancelled bookings free
the slot and are excluded from revenue and commission. Demo bookings in the seed data have no payment id, so cancelling
one shows "refund processing" (staff would refund those manually).

## E-mail (password reset, booking e-mails, contact form)

Set `PARKEASE_SMTP_HOST`, `PARKEASE_SMTP_PORT` (587), `PARKEASE_SMTP_USER`, `PARKEASE_SMTP_PASSWORD`,
`PARKEASE_SMTP_SECURITY` (`starttls` / `ssl` / `none`) and `PARKEASE_MAIL_FROM` (see `mailer.py`; Gmail needs an app
password). Without `PARKEASE_SMTP_HOST` nothing is sent: each e-mail is printed to the console and appended to
`instance/outbox.log`, which is how you test password reset locally.
Reset links are single-use, valid for 60 minutes, stored only as a hash, and the "forgot" form answers identically
whether or not the address has an account. `PARKEASE_CONTACT_EMAIL` sets where Contact messages go (default: the
admin account's e-mail).

## Header: About, Contact, Notifications

- **About** explains the service and how booking / cancellation works.
- **Contact** e-mails the message to the team (replies go to the customer) and notifies admins in the app.
- **Notifications** (bell with an unread badge, also on admin pages) lists booking confirmations, cancellations and
  refunds, new / cancelled reservations for establishments, password changes, and contact messages for admins.

## Finding parking (map)

Customers get **Find Parking** in the side panel: an OpenStreetMap map (Leaflet, no API key needed) with a pin per
establishment, free-slot counts, **Directions** and **Open in Google Maps** links, **Find parking near me** (browser
location, sorted by distance) and **Reserve here**. **My Bookings** also has a Directions button.
Establishments set their exact pin on **Parking Slots -> Map location**; the seeded coordinates are only approximate.
The map library and tiles load from public CDNs, so the page needs internet access.

## Dark mode

The moon/sun button now recolours the header and side panel as well as the page (all roles).

## Upgrading an existing database

Just start the new version: missing tables and columns are added automatically and existing bookings are kept
(they count as paid). Nothing needs to be reset.


## Deploying to Netlify (everything on Netlify)

On Netlify the app runs as: **static pages** (`pages/` + `public/`, assembled into `dist/` by `build.mjs`) +
**one Netlify Function** (`netlify/functions/api.mjs`, a JavaScript port of `app.py` with the same routes and
JSON) + **Postgres** via Netlify DB (Neon). The Flask/SQLite code (`app.py`, `database.py`, ...) is kept only for
running locally with `python app.py`; Netlify ignores it.

1. Push this folder to GitHub and import it in Netlify (settings come from `netlify.toml`), or use the CLI.
2. Add a database: Netlify dashboard > **Extensions > Netlify DB** (or run `npx netlify db init`). This sets
   `NETLIFY_DATABASE_URL` for you. Any other Postgres works too: set `DATABASE_URL` yourself.
3. Deploy. Tables are created automatically on the first request.

Optional environment variables (Site configuration > Environment variables):

| Variable | Purpose |
|----------|---------|
| `PARKEASE_SEED_DEMO` | `0` = start with an empty database (default seeds the demo accounts - turn off for a real launch) |
| `PARKEASE_ADMIN_EMAIL`, `PARKEASE_ADMIN_PASSWORD` | creates the first admin if no admin exists (password 8+ chars) |
| `PARKEASE_SECRET_KEY` | long random string for signing login cookies (defaults to a value derived from the database URL) |
| `PAYMONGO_SECRET_KEY` | real GCash / Maya / card payments. Without it a fake test checkout is used |
| `PAYMONGO_WEBHOOK_SECRET` | optional; webhook URL = `https://<your-site>/webhooks/paymongo` |
| `PARKEASE_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_SECURITY`, `PARKEASE_MAIL_FROM` | e-mail (password reset, receipts). Without SMTP, e-mails are only written to the function log |
| `PARKEASE_BASE_URL` | your public URL for e-mailed/payment links (defaults to the Netlify URL) |
| `PARKEASE_TZ`, `PARKEASE_REFUND_HOURS` | time zone (default `Asia/Manila`) and free-cancellation window (default 2) |

Demo logins (when seeded): `admin@parkease.com / admin123`, `citywalk@parkease.com / owner123`,
`juan@email.com / user123`.

Tests for the helper code: `npm install && npm test`.
