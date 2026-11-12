// ParkEase API - a single Netlify Function that replaces the old Flask app.
// Same routes and JSON shapes as before, so the HTML/JS front end is unchanged.
import { all, ensureDb, one, withTx, getPool } from "./lib/db.mjs";
import * as mailer from "./lib/mailer.mjs";
import * as payments from "./lib/payments.mjs";
import {
  checkPassword, hashPassword, makeSession, parseCookies, randomToken, readSession, sha256, verifyWebhook,
} from "./lib/security.mjs";
import {
  ApiError, addMinutes, asInt, cleanStr, fmt, fmtClock, fmtDay, hitRateLimit, money, nowLocal, nowStr,
  parseLocal, pesoText,
} from "./lib/util.mjs";

export const config = { path: ["/api/*", "/payment/*", "/pay/*", "/webhooks/*"] };

const MIN_MINUTES = 30;            // shortest reservation
const MAX_DAYS_AHEAD = 60;         // how far ahead a reservation can be made
const RESERVED_WINDOW_HOURS = 24;  // an incoming booking this close marks a slot "Reserved"
const CHECKOUT_HOLD_MINUTES = 20;  // an unpaid checkout holds its slot this long
const RESET_TOKEN_MINUTES = 60;
const REFUND_HOURS = Number(process.env.PARKEASE_REFUND_HOURS || 2);
const MAX_ATTEMPTS = 5, LOCKOUT_SECONDS = 300;
const HOME_FOR_ROLE = { user: "/user.html", establishment: "/establishment.html", admin: "/admin.html" };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9]{7,15}$/;
const SLOT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,14}$/;
const SESSION_COOKIE = "pe_session";

// Per-warm-instance throttles (best effort; the database-backed rules are the hard limits).
const failedLogins = new Map(), resetRequests = new Map(), resetAttempts = new Map(), contactSends = new Map();

/* ------------------------------------------------------------------ helpers */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const redirect = (location) => new Response(null, { status: 302, headers: { Location: location } });
const pad3 = (n) => String(n).padStart(3, "0");
const resCode = (r) => `RES-${r.created_at.slice(0, 4)}-${pad3(r.id)}`;

// Live state of a reservation; the first parameter placeholder ($1) must be "now".
const STATE_SQL = `CASE WHEN r.status = 'cancelled' THEN 'cancelled'
                        WHEN $1::text < r.start_at THEN 'incoming'
                        WHEN $1::text < r.end_at THEN 'ongoing'
                        ELSE 'completed' END`;

async function notify(db, userId, title, body = "") {
  await db.query("INSERT INTO notifications (user_id, title, body, created_at) VALUES ($1,$2,$3,$4)",
    [userId, title, body, nowStr()]);
}

const userJson = (u) => ({
  id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email,
  contact_number: u.contact_number, role: u.role,
});

function baseUrl(ctx) {
  return (process.env.PARKEASE_BASE_URL || process.env.URL || ctx.url.origin).replace(/\/+$/, "");
}

async function currentUser(ctx) {
  if (ctx._user !== undefined) return ctx._user;
  ctx._user = null;
  const sess = readSession(parseCookies(ctx.req.headers.get("cookie"))[SESSION_COOKIE]);
  if (sess) {
    const row = await one(getPool(), "SELECT * FROM users WHERE id = $1", [sess.uid]);
    if (row && row.status === "Active") ctx._user = row;
    else ctx.clearCookie = true;   // deleted or deactivated since login
  }
  return ctx._user;
}

async function requireRole(ctx, ...roles) {
  const user = await currentUser(ctx);
  if (!user) throw new ApiError("Please log in to continue.", 401);
  if (roles.length && !roles.includes(user.role)) throw new ApiError("You do not have access to this.", 403);
  return user;
}

async function jsonBody(ctx) {
  let data;
  try { data = await ctx.req.json(); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("Invalid request body.");
  return data;
}

function sessionCookie(ctx, value, maxAgeSec) {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (ctx.url.protocol === "https:") parts.push("Secure");
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join("; ");
}

/* ------------------------------------------------------- slots & pricing */
async function slotStates(db, estId) {
  const now = nowStr();
  const soon = fmt(addMinutes(nowLocal(), RESERVED_WINDOW_HOURS * 60));
  const rows = await all(db,
    `SELECT s.id, s.code, s.is_active,
            EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = s.id AND r.status = 'confirmed'
                    AND r.start_at <= $1 AND r.end_at > $1) AS occupied,
            EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = s.id AND r.status = 'confirmed'
                    AND r.start_at > $1 AND r.start_at <= $2) AS reserved
     FROM parking_slots s WHERE s.establishment_id = $3 ORDER BY s.code`, [now, soon, estId]);
  return rows.map((r) => ({
    id: r.id, code: r.code, is_active: !!r.is_active,
    state: !r.is_active ? "maintenance" : r.occupied ? "occupied" : r.reserved ? "reserved" : "available",
  }));
}

/** Validates date/arrival/departure and returns [start, end] as local Dates. */
function parseWindow(data) {
  const dateS = cleanStr(data.date, "Date", 10);
  const arrS = cleanStr(data.arrival, "Arrival", 5);
  const depS = cleanStr(data.departure, "Departure", 5);
  const start = parseLocal(`${dateS} ${arrS}`), end = parseLocal(`${dateS} ${depS}`);
  if (!start || !end) throw new ApiError("Please enter a valid date and times.");
  const now = nowLocal();
  if (start < now) throw new ApiError("Arrival time cannot be in the past.");
  if (start > addMinutes(now, MAX_DAYS_AHEAD * 1440)) {
    throw new ApiError(`Reservations can only be made up to ${MAX_DAYS_AHEAD} days ahead.`);
  }
  if (end <= start) throw new ApiError("Departure must be after arrival.");
  if (end - start < MIN_MINUTES * 60000) throw new ApiError(`The minimum reservation is ${MIN_MINUTES} minutes.`);
  return [start, end];
}

function priceFor(start, end, hourlyRate) {
  const minutes = Math.floor((end - start) / 60000);
  const hours = Math.ceil(minutes / 60);   // partial hours are billed as a full hour
  return { minutes, hours, amount: money(hours * hourlyRate) };
}

async function loadBookableSlot(db, slotId) {
  const row = await one(db,
    `SELECT s.id AS slot_id, s.code, s.is_active, e.id AS est_id, e.name, e.hourly_rate,
            e.commission_rate, e.status AS est_status
     FROM parking_slots s JOIN establishments e ON e.id = s.establishment_id WHERE s.id = $1`, [slotId]);
  if (!row || row.est_status !== "Active") throw new ApiError("That parking slot does not exist.", 404);
  if (!row.is_active) throw new ApiError("That parking slot is currently unavailable.", 409);
  return row;
}

/** Free = no confirmed booking overlaps and nobody else is part-way through paying for it. */
async function slotIsFree(db, slotId, start, end, ignoreCheckout = 0) {
  const s = fmt(start), e = fmt(end);
  if (await one(db,
    "SELECT 1 FROM reservations WHERE slot_id = $1 AND status = 'confirmed' AND start_at < $2 AND end_at > $3 LIMIT 1",
    [slotId, e, s])) return false;
  const cutoff = fmt(addMinutes(nowLocal(), -CHECKOUT_HOLD_MINUTES));
  const held = await one(db,
    `SELECT 1 FROM checkouts WHERE slot_id = $1 AND status = 'pending' AND created_at >= $2
     AND start_at < $3 AND end_at > $4 AND id != $5 LIMIT 1`, [slotId, cutoff, e, s, ignoreCheckout]);
  return !held;
}

/** Ids of an establishment's slots that are NOT free for a window (one query instead of two per slot). */
async function busySlotIds(db, estId, start, end) {
  const s = fmt(start), e = fmt(end);
  const cutoff = fmt(addMinutes(nowLocal(), -CHECKOUT_HOLD_MINUTES));
  const rows = await all(db,
    `SELECT r.slot_id FROM reservations r JOIN parking_slots p ON p.id = r.slot_id
       WHERE p.establishment_id = $1 AND r.status = 'confirmed' AND r.start_at < $3 AND r.end_at > $2
     UNION
     SELECT c.slot_id FROM checkouts c JOIN parking_slots p ON p.id = c.slot_id
       WHERE p.establishment_id = $1 AND c.status = 'pending' AND c.created_at >= $4
         AND c.start_at < $3 AND c.end_at > $2`, [estId, s, e, cutoff]);
  return new Set(rows.map((r) => r.slot_id));
}

/* ---------------------------------------------------------------- auth */
async function register(ctx) {
  const data = await jsonBody(ctx);
  const first = cleanStr(data.first_name, "First name", 50);
  const last = cleanStr(data.last_name, "Last name", 50);
  const email = cleanStr(data.email, "Email", 120).toLowerCase();
  const contact = cleanStr(data.contact_number, "Contact number", 20).replace(/[ -]/g, "");
  const password = data.password;
  if (!EMAIL_RE.test(email)) throw new ApiError("Please enter a valid email address.");
  if (!PHONE_RE.test(contact)) throw new ApiError("Please enter a valid contact number (7-15 digits).");
  if (typeof password !== "string" || password.length < 8) throw new ApiError("Password must be at least 8 characters.");
  if (password.length > 128) throw new ApiError("Password is too long.");
  try {
    await getPool().query(
      "INSERT INTO users (first_name,last_name,email,contact_number,password_hash,role,status,created_at)" +
      " VALUES ($1,$2,$3,$4,$5,'user','Active',$6)",
      [first, last, email, contact, await hashPassword(password), nowStr()]);
  } catch (err) {
    if (err.code === "23505") throw new ApiError("An account with that email already exists.", 409);
    throw err;
  }
  return json({ ok: true }, 201);
}

async function login(ctx) {
  const data = await jsonBody(ctx);
  const email = cleanStr(data.email, "Email", 120).toLowerCase();
  const password = data.password;
  if (typeof password !== "string" || !password) throw new ApiError("Password is required.");

  const key = `${ctx.ip}|${email}`, now = Date.now() / 1000;
  const attempts = (failedLogins.get(key) || []).filter((t) => now - t < LOCKOUT_SECONDS);
  if (attempts.length >= MAX_ATTEMPTS) throw new ApiError("Too many failed attempts. Please try again in a few minutes.", 429);

  const user = await one(getPool(), "SELECT * FROM users WHERE lower(email) = $1", [email]);
  if (!user || !(await checkPassword(user.password_hash, password))) {
    attempts.push(now); failedLogins.set(key, attempts);
    throw new ApiError("Incorrect email or password.", 401);
  }
  if (user.status !== "Active") throw new ApiError("This account is inactive. Please contact the administrator.", 403);

  failedLogins.delete(key);
  const remember = !!data.remember;
  const days = remember ? 30 : 1;   // the signed token itself expires after a day unless "remember me"
  ctx.setCookie = sessionCookie(ctx, makeSession(user.id, days), remember ? days * 86400 : undefined);
  return json({ user: userJson(user), redirect: HOME_FOR_ROLE[user.role] });
}

async function logout(ctx) {
  ctx.setCookie = sessionCookie(ctx, "", 0);
  return json({ ok: true });
}

async function me(ctx) {
  const user = await requireRole(ctx);
  const out = userJson(user);
  if (user.role === "establishment") {
    const est = await one(getPool(), "SELECT name FROM establishments WHERE owner_id = $1", [user.id]);
    out.establishment_name = est ? est.name : null;
  }
  return json(out);
}

/* -------------------------------------------------------- password reset */
async function passwordForgot(ctx) {
  const data = await jsonBody(ctx);
  const email = cleanStr(data.email, "Email", 120).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ApiError("Please enter a valid email address.");
  if (hitRateLimit(resetRequests, ctx.ip, 5, 900) || hitRateLimit(resetRequests, "mail|" + email, 3, 900)) {
    throw new ApiError("Too many requests. Please try again in a few minutes.", 429);
  }
  const db = getPool();
  const user = await one(db, "SELECT * FROM users WHERE lower(email) = $1", [email]);
  if (user && user.status === "Active") {
    const token = randomToken(32);
    const expires = addMinutes(nowLocal(), RESET_TOKEN_MINUTES);
    await db.query("UPDATE password_resets SET used = 1 WHERE user_id = $1 AND used = 0", [user.id]);
    await db.query("INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4)",
      [user.id, sha256(token), fmt(expires), nowStr()]);
    await mailer.sendMail(user.email, "Reset your ParkEase password",
      `Hi ${user.first_name},\n\nWe received a request to reset your ParkEase password. ` +
      `Open this link to choose a new one (valid for ${RESET_TOKEN_MINUTES} minutes):\n\n` +
      `${baseUrl(ctx)}/reset.html?token=${token}\n\n` +
      "If you didn't ask for this, you can ignore this e-mail - your password stays the same.\n");
  }
  return json({ ok: true, message: "If an account exists for that email, a reset link is on its way." });
}

async function passwordReset(ctx) {
  const data = await jsonBody(ctx);
  const { token, password } = data;
  if (hitRateLimit(resetAttempts, ctx.ip, 10, 900)) throw new ApiError("Too many attempts. Please try again in a few minutes.", 429);
  if (typeof token !== "string" || !token) throw new ApiError("This reset link is invalid or has expired.");
  if (typeof password !== "string" || password.length < 8) throw new ApiError("Password must be at least 8 characters.");
  if (password.length > 128) throw new ApiError("Password is too long.");
  const newHash = await hashPassword(password);
  const row = await withTx(async (c) => {
    const r = await one(c,
      `SELECT pr.id, pr.user_id, u.email, u.first_name, u.status FROM password_resets pr
       JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = $1 AND pr.used = 0 AND pr.expires_at >= $2`,
      [sha256(token), nowStr()]);
    if (!r || r.status !== "Active") throw new ApiError("This reset link is invalid or has expired. Please request a new one.");
    await c.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, r.user_id]);
    await c.query("UPDATE password_resets SET used = 1 WHERE user_id = $1", [r.user_id]);
    await notify(c, r.user_id, "Password changed", "Your ParkEase password was reset.");
    return r;
  });
  failedLogins.clear();   // a reset also clears any login lockout
  await mailer.sendMail(row.email, "Your ParkEase password was changed",
    `Hi ${row.first_name},\n\nYour password was just changed. If this wasn't you, contact ParkEase support right away.\n`);
  return json({ ok: true });
}

/* ---------------------------------------------- notifications + contact */
async function listNotifications(ctx) {
  const user = await requireRole(ctx);
  const db = getPool();
  const rows = await all(db, "SELECT id, title, body, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 30", [user.id]);
  const unread = (await one(db, "SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = 0", [user.id])).n;
  return json({ unread, items: rows.map((n) => ({ id: n.id, title: n.title, body: n.body, read: !!n.is_read, created_at: n.created_at })) });
}

async function markNotificationsRead(ctx) {
  const user = await requireRole(ctx);
  const data = await jsonBody(ctx);
  const db = getPool();
  if (data.id === undefined || data.id === null) {
    await db.query("UPDATE notifications SET is_read = 1 WHERE user_id = $1", [user.id]);
  } else {
    await db.query("UPDATE notifications SET is_read = 1 WHERE user_id = $1 AND id = $2", [user.id, asInt(data.id, "Notification")]);
  }
  return json({ ok: true });
}

async function contact(ctx) {
  const user = await requireRole(ctx);
  const data = await jsonBody(ctx);
  const subject = cleanStr(data.subject, "Subject", 120);
  const message = cleanStr(data.message, "Message", 2000);
  if (message.length < 10) throw new ApiError("Please write a little more so we can help.");
  if (hitRateLimit(contactSends, String(user.id), 5, 3600)) throw new ApiError("You've sent several messages recently. Please try again later.", 429);
  const name = `${user.first_name} ${user.last_name}`;
  const admins = await withTx(async (c) => {
    await c.query("INSERT INTO contact_messages (user_id,name,email,subject,message,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [user.id, name, user.email, subject, message, nowStr()]);
    const a = await all(c, "SELECT id, email FROM users WHERE role = 'admin' AND status = 'Active'");
    for (const adm of a) await notify(c, adm.id, `Message from ${name}`, `${subject}: ${message.slice(0, 160)}`);
    await notify(c, user.id, "Message sent", `We received "${subject}" and will reply by email.`);
    return a;
  });
  const inbox = process.env.PARKEASE_CONTACT_EMAIL || (admins[0] && admins[0].email);
  if (inbox) {
    await mailer.sendMail(inbox, `[ParkEase contact] ${subject}`,
      `From: ${name} <${user.email}> (${user.role})\n\n${message}\n`, user.email);
  }
  return json({ ok: true }, 201);
}

/* ------------------------------------------------- customer: browse/quote */
async function parkingLocations(ctx) {
  await requireRole(ctx, "user");
  const db = getPool();
  const out = [];
  for (const e of await all(db, "SELECT * FROM establishments WHERE status = 'Active' ORDER BY name")) {
    const states = await slotStates(db, e.id);
    out.push({
      id: e.id, name: e.name, address: e.location, contact_number: e.contact_number, image: e.image,
      hourly_rate: e.hourly_rate, latitude: e.latitude, longitude: e.longitude,
      total_slots: states.filter((s) => s.state !== "maintenance").length,
      available_slots: states.filter((s) => s.state === "available").length,
    });
  }
  return json(out);
}

async function listEstablishments(ctx) {
  await requireRole(ctx, "user");
  const db = getPool();
  const out = [];
  for (const e of await all(db, "SELECT * FROM establishments WHERE status = 'Active' ORDER BY name")) {
    const states = await slotStates(db, e.id);
    out.push({
      id: e.id, name: e.name, location: e.location, image: e.image, hourly_rate: e.hourly_rate,
      total_slots: states.filter((s) => s.state !== "maintenance").length,
      available_slots: states.filter((s) => s.state === "available").length,
    });
  }
  return json(out);
}

async function establishmentSlots(ctx, { id }) {
  await requireRole(ctx, "user");
  const db = getPool();
  const est = await one(db, "SELECT * FROM establishments WHERE id = $1 AND status = 'Active'", [Number(id)]);
  if (!est) throw new ApiError("Establishment not found.", 404);
  const states = await slotStates(db, est.id);
  const q = ctx.url.searchParams;
  let busy = null;
  if (q.get("date") && q.get("arrival") && q.get("departure")) {
    try {
      const [s, e] = parseWindow({ date: q.get("date"), arrival: q.get("arrival"), departure: q.get("departure") });
      busy = await busySlotIds(db, est.id, s, e);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;   // invalid window: fall back to the state right now
    }
  }
  const slots = states.filter((s) => s.state !== "maintenance").map((s) => ({
    id: s.id, code: s.code, free: busy === null ? s.state === "available" : !busy.has(s.id),
  }));
  return json({ slots, hourly_rate: est.hourly_rate });
}

async function quoteReservation(ctx) {
  await requireRole(ctx, "user");
  const data = await jsonBody(ctx);
  const db = getPool();
  const slot = await loadBookableSlot(db, asInt(data.slot_id, "Slot"));
  const [start, end] = parseWindow(data);
  if (!(await slotIsFree(db, slot.slot_id, start, end))) {
    throw new ApiError("That slot is already reserved for the selected time. Please pick another.", 409);
  }
  const { minutes, hours, amount } = priceFor(start, end, slot.hourly_rate);
  return json({ minutes, hours_billed: hours, hourly_rate: slot.hourly_rate, amount });
}

/* ------------------------------------------------------------- payments */
async function startCheckout(ctx) {
  const user = await requireRole(ctx, "user");
  const data = await jsonBody(ctx);
  const [start, end] = parseWindow(data);
  const slotId = asInt(data.slot_id, "Slot");
  const token = randomToken(24);
  const made = await withTx(async (c) => {
    const slot = await loadBookableSlot(c, slotId);
    if (!(await slotIsFree(c, slotId, start, end))) {
      throw new ApiError("That slot is no longer available for the selected time. Please pick another.", 409);
    }
    const { minutes, hours, amount } = priceFor(start, end, slot.hourly_rate);
    if (amount <= 0) throw new ApiError("This slot has no price set, so it can't be booked online.", 409);
    const row = await one(c,
      "INSERT INTO checkouts (token,user_id,slot_id,start_at,end_at,hours_billed,amount,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [token, user.id, slotId, fmt(start), fmt(end), hours, amount, nowStr()]);
    return { id: row.id, slot, minutes, hours, amount };
  });

  const db = getPool();
  let sessionId, url;
  if (payments.mode() === "mock") {
    sessionId = "mock_" + token; url = `/pay/mock/${token}`;
  } else {
    try {
      const r = await payments.createCheckout({
        amount: made.amount,
        name: `Parking at ${made.slot.name} (slot ${made.slot.code})`,
        description: `${fmtDay(start)} ${fmtClock(start)} - ${fmtClock(end)}, ${made.hours} h`,
        reference: `PE-CHK-${made.id}`,
        successUrl: `${baseUrl(ctx)}/payment/return?c=${token}`,
        cancelUrl: `${baseUrl(ctx)}/payment/return?c=${token}&cancelled=1`,
        customerName: `${user.first_name} ${user.last_name}`, customerEmail: user.email,
      });
      sessionId = r.id; url = r.url;
    } catch (err) {
      if (!(err instanceof payments.PaymentError)) throw err;
      await db.query("UPDATE checkouts SET status = 'failed' WHERE id = $1", [made.id]);
      console.error("Checkout creation failed:", err.message);
      throw new ApiError(err.message, 502);
    }
  }
  await db.query("UPDATE checkouts SET session_id = $1 WHERE id = $2", [sessionId, made.id]);
  return json({ url, amount: made.amount, minutes: made.minutes, mode: payments.mode() }, 201);
}

/** Ask the gateway (never the browser) whether this checkout was paid. */
async function verifyPayment(co) {
  if (payments.mode() === "mock") return { paid: !!co.mock_paid, paymentId: "mock_pay_" + co.token, method: "test mode" };
  if (!co.session_id) return { paid: false, paymentId: null, method: "" };
  return payments.getCheckout(co.session_id);
}

/** Turns a paid checkout into a reservation. Safe to call repeatedly (return page + webhook may both arrive). */
async function finalizeCheckout(co) {
  if (co.status === "paid") return co.reservation_id;
  if (co.status === "failed") return null;
  const info = await verifyPayment(co);
  if (!info.paid) return null;
  const start = parseLocal(co.start_at), end = parseLocal(co.end_at);

  const result = await withTx(async (c) => {
    const cur = await one(c, "SELECT * FROM checkouts WHERE id = $1", [co.id]);
    if (cur.status === "paid") return { rid: cur.reservation_id };
    let slot = null, ok = false;
    try {
      slot = await loadBookableSlot(c, cur.slot_id);
      ok = await slotIsFree(c, cur.slot_id, start, end, cur.id);
    } catch (err) { if (!(err instanceof ApiError)) throw err; }
    if (!ok) {
      // Paid, but the slot can no longer be given to this customer: refund automatically.
      await c.query("UPDATE checkouts SET status = 'failed' WHERE id = $1", [cur.id]);
      let note = "Your payment was received but the slot was no longer available.";
      try {
        if (payments.mode() === "paymongo" && info.paymentId) {
          await payments.refund(info.paymentId, cur.amount, "others");
          note += " It has been refunded.";
        } else note += " Any payment taken will be refunded.";
      } catch (err) {
        if (!(err instanceof payments.PaymentError)) throw err;
        note += " We could not refund automatically - please contact us.";
      }
      await notify(c, cur.user_id, "Booking could not be completed", note);
      return { rid: null };
    }
    const rid = (await one(c,
      `INSERT INTO reservations (user_id,establishment_id,slot_id,start_at,end_at,hours_billed,hourly_rate,amount,
         commission_rate,created_at,payment_status,payment_method,payment_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid',$11,$12) RETURNING id`,
      [cur.user_id, slot.est_id, cur.slot_id, cur.start_at, cur.end_at, cur.hours_billed, slot.hourly_rate, cur.amount,
        slot.commission_rate, nowStr(), info.method || "", info.paymentId || ""])).id;
    await c.query("UPDATE checkouts SET status = 'paid', reservation_id = $1 WHERE id = $2", [rid, cur.id]);
    const when = `${fmtDay(start)} ${fmtClock(start)} - ${fmtClock(end)}`;
    await notify(c, cur.user_id, "Booking confirmed", `${slot.name}, slot ${slot.code}, ${when}. Paid ${pesoText(cur.amount)}.`);
    const owner = await one(c, "SELECT owner_id FROM establishments WHERE id = $1", [slot.est_id]);
    if (owner) await notify(c, owner.owner_id, "New reservation", `Slot ${slot.code}, ${when}.`);
    return { rid, slot, when, amount: cur.amount, userId: cur.user_id };
  });

  if (result.rid && result.slot) {
    const customer = await one(getPool(), "SELECT email, first_name FROM users WHERE id = $1", [result.userId]);
    await mailer.sendMail(customer.email, "ParkEase booking confirmed",
      `Hi ${customer.first_name},\n\nYour parking booking is confirmed.\n\nLocation: ${result.slot.name}\n` +
      `Slot: ${result.slot.code}\nWhen: ${result.when}\nPaid: ${pesoText(result.amount)}\n\n` +
      "You can cancel from My Bookings in ParkEase.\n");
  }
  return result.rid;
}

async function paymentReturn(ctx) {
  const user = await currentUser(ctx);
  const db = getPool();
  const co = await one(db, "SELECT * FROM checkouts WHERE token = $1", [ctx.url.searchParams.get("c") || ""]);
  if (!user || !co || co.user_id !== user.id) return redirect("/");
  if (ctx.url.searchParams.get("cancelled") && co.status === "pending") {
    await db.query("UPDATE checkouts SET status = 'expired' WHERE id = $1", [co.id]);   // release the hold
    return redirect("/user.html?payment=cancelled");
  }
  let rid;
  try { rid = await finalizeCheckout(co); }
  catch (err) {
    if (err instanceof payments.PaymentError) return redirect("/user3.html?payment=pending");
    throw err;
  }
  if (rid) return redirect("/user3.html?payment=success");
  const now = await one(db, "SELECT status FROM checkouts WHERE id = $1", [co.id]);
  return redirect(now.status === "failed" ? "/user.html?payment=failed" : "/user3.html?payment=pending");
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const mockPage = (what, amount) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Test payment</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#eef2f8;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;padding:28px;border-radius:16px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,.15)}
.t{background:#fff3b4;color:#6b4e00;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 6px;color:#1f4072}.a{font-size:32px;font-weight:700;margin:12px 0}
button{width:100%;padding:12px;border:0;border-radius:10px;font-size:16px;cursor:pointer;margin-top:8px}
.p{background:#1f4072;color:#fff}.x{background:#e4e8f0}</style></head><body><div class="c">
<div class="t"><b>TEST MODE</b> - no real money moves. Set PAYMONGO_SECRET_KEY to use the real gateway.</div>
<h1>ParkEase checkout</h1><div>${esc(what)}</div><div class="a">${esc(amount)}</div>
<form method="post"><button class="p" name="result" value="pay">Simulate successful payment</button>
<button class="x" name="result" value="cancel">Cancel</button></form></div></body></html>`;

async function mockCheckout(ctx, { token }) {
  const user = await currentUser(ctx);
  const db = getPool();
  const co = await one(db,
    `SELECT c.*, e.name AS est_name, s.code AS slot_code FROM checkouts c
     JOIN parking_slots s ON s.id = c.slot_id JOIN establishments e ON e.id = s.establishment_id WHERE c.token = $1`, [token]);
  if (payments.mode() !== "mock" || !user || !co || co.user_id !== user.id || co.status !== "pending") return redirect("/");
  if (ctx.req.method === "POST") {
    const form = await ctx.req.formData();
    if (form.get("result") === "pay") {
      await db.query("UPDATE checkouts SET mock_paid = 1 WHERE id = $1", [co.id]);
      return redirect(`/payment/return?c=${token}`);
    }
    return redirect(`/payment/return?c=${token}&cancelled=1`);
  }
  return new Response(mockPage(`${co.est_name} - slot ${co.slot_code}`, pesoText(co.amount)),
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function paymongoWebhook(ctx) {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET || "";
  if (!secret) return json({ error: "Not found." }, 404);
  const raw = await ctx.req.text();
  if (!verifyWebhook(raw, ctx.req.headers.get("paymongo-signature") || "", secret)) return json({ error: "Bad signature." }, 400);
  try {
    const attrs = JSON.parse(raw).data.attributes;
    if (attrs.type === "checkout_session.payment.paid") {
      const co = await one(getPool(), "SELECT * FROM checkouts WHERE session_id = $1", [attrs.data.id]);
      if (co) await finalizeCheckout(co);
    }
  } catch (err) {
    if (err instanceof payments.PaymentError) return json({ error: "Try again." }, 503);   // let PayMongo retry
    if (!(err instanceof TypeError || err instanceof SyntaxError)) throw err;               // unknown event: acknowledge
  }
  return json({ ok: true });
}

/* ---------------------------------------------- my bookings + cancelling */
async function myReservations(ctx) {
  const user = await requireRole(ctx, "user");
  const limit = Math.min(Math.max(asInt(ctx.url.searchParams.get("limit") ?? 10, "Limit"), 1), 100);
  const order = ctx.url.searchParams.get("sort") === "start" ? "r.start_at DESC, r.id DESC" : "r.created_at DESC, r.id DESC";
  const rows = await all(getPool(),
    `SELECT r.*, e.name AS est_name, e.location AS est_location, e.latitude, e.longitude,
            s.code AS slot_code, ${STATE_SQL} AS state
     FROM reservations r JOIN establishments e ON e.id = r.establishment_id
     JOIN parking_slots s ON s.id = r.slot_id
     WHERE r.user_id = $2 ORDER BY ${order} LIMIT $3`, [nowStr(), user.id, limit]);
  const now = nowLocal();
  return json(rows.map((r) => {
    const start = parseLocal(r.start_at);
    return {
      id: r.id, code: resCode(r), location: r.est_name, address: r.est_location, slot: r.slot_code,
      start_at: r.start_at, end_at: r.end_at, amount: r.amount, status: r.state, payment_status: r.payment_status,
      can_cancel: r.state === "incoming",
      refundable: r.state === "incoming" && start - now >= REFUND_HOURS * 3600000,
      latitude: r.latitude, longitude: r.longitude, refund_hours: REFUND_HOURS,
    };
  }));
}

async function cancelReservation(ctx, { id }) {
  const user = await requireRole(ctx, "user");
  const resId = Number(id);
  const out = await withTx(async (c) => {
    const r = await one(c,
      `SELECT r.*, e.name AS est_name, e.owner_id, s.code AS slot_code FROM reservations r
       JOIN establishments e ON e.id = r.establishment_id JOIN parking_slots s ON s.id = r.slot_id
       WHERE r.id = $1 AND r.user_id = $2`, [resId, user.id]);
    if (!r) throw new ApiError("Reservation not found.", 404);
    if (r.status === "cancelled") throw new ApiError("This reservation is already cancelled.", 409);
    const start = parseLocal(r.start_at), now = nowLocal();
    if (start <= now) throw new ApiError("This reservation has already started, so it can't be cancelled.", 409);

    const refundable = start - now >= REFUND_HOURS * 3600000;
    let payStatus;
    if (!refundable) payStatus = "no_refund";
    else if (payments.mode() === "mock") payStatus = "refunded";
    else if (r.payment_ref) {
      try { payStatus = (await payments.refund(r.payment_ref, r.amount)) === "succeeded" ? "refunded" : "refund_pending"; }
      catch (err) {   // keep the booking so the customer can retry
        if (!(err instanceof payments.PaymentError)) throw err;
        throw new ApiError(`The refund could not be processed, so the booking was not cancelled. ${err.message}`, 502);
      }
    } else payStatus = "refund_pending";   // paid outside the gateway (e.g. demo data): staff refund manually

    await c.query("UPDATE reservations SET status = 'cancelled', cancelled_at = $1, payment_status = $2 WHERE id = $3",
      [nowStr(), payStatus, resId]);
    const when = `${fmtDay(start)} ${fmtClock(start)}`;
    const refundText = {
      refunded: `${pesoText(r.amount)} is being refunded to your original payment method.`,
      refund_pending: "Your refund is being processed.",
      no_refund: `It was cancelled less than ${REFUND_HOURS} hour(s) before arrival, so it is not refundable.`,
    }[payStatus];
    await notify(c, user.id, "Booking cancelled", `${r.est_name}, slot ${r.slot_code}, ${when}. ${refundText}`);
    await notify(c, r.owner_id, "Reservation cancelled", `Slot ${r.slot_code}, ${when} was cancelled.`);
    return { r, when, refundText, payStatus };
  });
  await mailer.sendMail(user.email, "ParkEase booking cancelled",
    `Hi ${user.first_name},\n\nYour booking at ${out.r.est_name} (slot ${out.r.slot_code}) on ${out.when} has been cancelled.\n${out.refundText}\n`);
  return json({ ok: true, payment_status: out.payStatus, message: out.refundText });
}

/* ---------------------------------------------------------- establishment */
async function myEstablishment(db, user) {
  const est = await one(db, "SELECT * FROM establishments WHERE owner_id = $1", [user.id]);
  if (!est) throw new ApiError("No establishment is linked to this account.", 404);
  return est;
}

async function estOverview(ctx) {
  const user = await requireRole(ctx, "establishment");
  const db = getPool();
  const est = await myEstablishment(db, user);
  const counts = { incoming: 0, ongoing: 0, completed: 0 };
  let revenue = 0;
  for (const r of await all(db, `SELECT r.amount, ${STATE_SQL} AS state FROM reservations r WHERE r.establishment_id = $2`, [nowStr(), est.id])) {
    if (r.state !== "cancelled") { counts[r.state] += 1; revenue += r.amount; }
  }
  const states = (await slotStates(db, est.id)).map((s) => s.state);
  const n = (k) => states.filter((s) => s === k).length;
  return json({
    name: est.name, revenue: money(revenue),
    reservations_total: counts.incoming + counts.ongoing + counts.completed,
    incoming: counts.incoming + counts.ongoing,   // every booking that has not finished yet
    completed: counts.completed,
    slots_available: n("available"), slots_reserved: n("reserved"), slots_occupied: n("occupied"),
  });
}

async function estReservations(ctx) {
  const user = await requireRole(ctx, "establishment");
  const db = getPool();
  const est = await myEstablishment(db, user);
  const rows = await all(db,
    `SELECT r.*, u.first_name, u.last_name, s.code AS slot_code, ${STATE_SQL} AS state
     FROM reservations r JOIN users u ON u.id = r.user_id JOIN parking_slots s ON s.id = r.slot_id
     WHERE r.establishment_id = $2 ORDER BY r.start_at DESC, r.id DESC`, [nowStr(), est.id]);
  return json(rows.map((r) => ({
    id: r.id, code: resCode(r), customer: `${r.first_name} ${r.last_name}`, slot: r.slot_code,
    start_at: r.start_at, end_at: r.end_at, amount: r.amount, status: r.state,
  })));
}

async function estSlotList(ctx) {
  const user = await requireRole(ctx, "establishment");
  const db = getPool();
  const est = await myEstablishment(db, user);
  return json({ slots: await slotStates(db, est.id) });
}

async function getLocation(ctx) {
  const user = await requireRole(ctx, "establishment");
  const est = await myEstablishment(getPool(), user);
  return json({ address: est.location, latitude: est.latitude, longitude: est.longitude });
}

async function setLocation(ctx) {
  const user = await requireRole(ctx, "establishment");
  const data = await jsonBody(ctx);
  const db = getPool();
  const est = await myEstablishment(db, user);
  const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" ? NaN : Number(v));
  const lat = num(data.latitude), lng = num(data.longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) throw new ApiError("Latitude and longitude must be numbers.");
  if (!(Number.isFinite(lat) && Number.isFinite(lng)) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new ApiError("That latitude/longitude is out of range.");
  }
  const address = cleanStr(data.address === undefined ? est.location : data.address, "Address", 160);
  await db.query("UPDATE establishments SET latitude = $1, longitude = $2, location = $3 WHERE id = $4", [lat, lng, address, est.id]);
  return json({ ok: true });
}

async function addSlot(ctx) {
  const user = await requireRole(ctx, "establishment");
  const db = getPool();
  const est = await myEstablishment(db, user);
  const code = cleanStr((await jsonBody(ctx)).code, "Slot code", 15).toUpperCase();
  if (!SLOT_CODE_RE.test(code)) throw new ApiError("Slot code may only contain letters, numbers, spaces, - and _.");
  try {
    await db.query("INSERT INTO parking_slots (establishment_id, code) VALUES ($1,$2)", [est.id, code]);
  } catch (err) {
    if (err.code === "23505") throw new ApiError(`Slot ${code} already exists.`, 409);
    throw err;
  }
  return json({ ok: true }, 201);
}

async function ownSlot(db, user, slotId) {
  const est = await myEstablishment(db, user);
  const slot = await one(db, "SELECT * FROM parking_slots WHERE id = $1 AND establishment_id = $2", [slotId, est.id]);
  if (!slot) throw new ApiError("Slot not found.", 404);
  return slot;
}

async function updateSlot(ctx, { id }) {
  const user = await requireRole(ctx, "establishment");
  const db = getPool();
  await ownSlot(db, user, Number(id));
  const active = (await jsonBody(ctx)).is_active;
  if (typeof active !== "boolean") throw new ApiError("is_active must be true or false.");
  await db.query("UPDATE parking_slots SET is_active = $1 WHERE id = $2", [active ? 1 : 0, Number(id)]);
  return json({ ok: true });
}

async function deleteSlot(ctx, { id }) {
  const user = await requireRole(ctx, "establishment");
  const db = getPool();
  await ownSlot(db, user, Number(id));
  if (await one(db, "SELECT 1 FROM reservations WHERE slot_id = $1 LIMIT 1", [Number(id)])) {
    throw new ApiError("This slot has reservation history, so it can't be deleted. Set it to maintenance instead.", 409);
  }
  await db.query("DELETE FROM parking_slots WHERE id = $1", [Number(id)]);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ admin */
const establishmentStats = (db) => all(db,
  `SELECT e.id, e.name, e.location, e.contact_number, e.status, e.commission_rate,
          COUNT(r.id)::int AS reservations,
          COALESCE(SUM(r.amount), 0) AS revenue,
          COALESCE(SUM(r.amount * r.commission_rate / 100.0), 0) AS commission
   FROM establishments e
   LEFT JOIN reservations r ON r.establishment_id = e.id AND r.status = 'confirmed'
   GROUP BY e.id ORDER BY e.id`);

const statRow = (s) => ({
  name: s.name, reservations: s.reservations, revenue: money(s.revenue),
  commission_rate: s.commission_rate, commission: money(s.commission),
});

async function adminDashboard(ctx) {
  await requireRole(ctx, "admin");
  const db = getPool();
  const stats = await establishmentStats(db);
  return json({
    total_commission: money(stats.reduce((a, s) => a + Number(s.commission), 0)),
    total_users: (await one(db, "SELECT COUNT(*)::int AS n FROM users WHERE role = 'user'")).n,
    total_establishments: stats.length,
    establishments: stats.map(statRow),
  });
}

async function adminUsers(ctx) {
  await requireRole(ctx, "admin");
  const rows = await all(getPool(), "SELECT * FROM users WHERE role = 'user' ORDER BY id");
  return json(rows.map((u) => ({
    id: u.id, code: `USR-${pad3(u.id)}`, name: `${u.first_name} ${u.last_name}`, email: u.email,
    contact_number: u.contact_number, created_at: u.created_at.slice(0, 10), status: u.status,
  })));
}

function readStatus(data) {
  if (data.status !== "Active" && data.status !== "Inactive") throw new ApiError("Status must be Active or Inactive.");
  return data.status;
}

async function adminUpdateUser(ctx, { id }) {
  await requireRole(ctx, "admin");
  const status = readStatus(await jsonBody(ctx));
  const r = await getPool().query("UPDATE users SET status = $1 WHERE id = $2 AND role = 'user'", [status, Number(id)]);
  if (r.rowCount === 0) throw new ApiError("User not found.", 404);
  return json({ ok: true });
}

async function adminEstablishments(ctx) {
  await requireRole(ctx, "admin");
  return json((await establishmentStats(getPool())).map((s) => ({
    id: s.id, code: `EST-${pad3(s.id)}`, name: s.name, location: s.location,
    contact_number: s.contact_number, reservations: s.reservations, status: s.status,
  })));
}

async function adminUpdateEstablishment(ctx, { id }) {
  await requireRole(ctx, "admin");
  const status = readStatus(await jsonBody(ctx));
  const r = await getPool().query("UPDATE establishments SET status = $1 WHERE id = $2", [status, Number(id)]);
  if (r.rowCount === 0) throw new ApiError("Establishment not found.", 404);
  return json({ ok: true });
}

async function adminReports(ctx) {
  await requireRole(ctx, "admin");
  const months = Math.min(Math.max(asInt(ctx.url.searchParams.get("months") ?? 6, "Months"), 1), 24);
  const db = getPool();
  const now = nowLocal();
  let y = now.getUTCFullYear(), m = now.getUTCMonth();   // walk back to cover `months` calendar months
  m -= months - 1;
  while (m < 0) { m += 12; y -= 1; }
  const since = `${y}-${String(m + 1).padStart(2, "0")}`;
  const byMonth = await all(db,
    `SELECT substr(start_at, 1, 7) AS month, COUNT(*)::int AS reservations,
            SUM(amount) AS revenue, SUM(amount * commission_rate / 100.0) AS commission
     FROM reservations WHERE status = 'confirmed' AND start_at >= $1
     GROUP BY substr(start_at, 1, 7) ORDER BY month DESC`, [`${since}-01 00:00`]);
  return json({
    since,
    months: byMonth.map((r) => ({ month: r.month, reservations: r.reservations, revenue: money(r.revenue), commission: money(r.commission) })),
    establishments: (await establishmentStats(db)).map(statRow),
  });
}

const csvSafe = (v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
const csvCell = (v) => { const s = String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function adminReportsCsv(ctx) {
  await requireRole(ctx, "admin");
  const rows = await all(getPool(),
    `SELECT r.id, r.created_at, e.name AS est, s.code AS slot, u.first_name, u.last_name,
            r.start_at, r.end_at, r.hours_billed, r.amount, r.commission_rate,
            r.amount * r.commission_rate / 100.0 AS commission, ${STATE_SQL} AS state
     FROM reservations r JOIN establishments e ON e.id = r.establishment_id
     JOIN parking_slots s ON s.id = r.slot_id JOIN users u ON u.id = r.user_id
     ORDER BY r.start_at DESC`, [nowStr()]);
  const lines = [["Reservation", "Establishment", "Slot", "Customer", "Start", "End", "Hours billed",
    "Amount", "Commission %", "Commission", "Status"]];
  for (const r of rows) {
    lines.push([resCode(r), csvSafe(r.est), csvSafe(r.slot), csvSafe(`${r.first_name} ${r.last_name}`), r.start_at, r.end_at,
      r.hours_billed, Number(r.amount).toFixed(2), r.commission_rate, Number(r.commission).toFixed(2), r.state]);
  }
  return new Response(lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=parkease-reservations.csv" },
  });
}

/* ----------------------------------------------------------------- router */
const ROUTES = [
  ["POST", "/api/register", register], ["POST", "/api/login", login], ["POST", "/api/logout", logout],
  ["GET", "/api/me", me],
  ["POST", "/api/password/forgot", passwordForgot], ["POST", "/api/password/reset", passwordReset],
  ["GET", "/api/notifications", listNotifications], ["POST", "/api/notifications/read", markNotificationsRead],
  ["POST", "/api/contact", contact],
  ["GET", "/api/parking-locations", parkingLocations],
  ["GET", "/api/establishments", listEstablishments],
  ["GET", "/api/establishments/:id/slots", establishmentSlots],
  ["POST", "/api/reservations/quote", quoteReservation],
  ["POST", "/api/reservations/checkout", startCheckout],
  ["GET", "/api/reservations/mine", myReservations],
  ["POST", "/api/reservations/:id/cancel", cancelReservation],
  ["GET", "/payment/return", paymentReturn],
  ["GET", "/pay/mock/:token", mockCheckout], ["POST", "/pay/mock/:token", mockCheckout],
  ["POST", "/webhooks/paymongo", paymongoWebhook],
  ["GET", "/api/establishment/overview", estOverview],
  ["GET", "/api/establishment/reservations", estReservations],
  ["GET", "/api/establishment/slots", estSlotList], ["POST", "/api/establishment/slots", addSlot],
  ["PATCH", "/api/establishment/slots/:id", updateSlot], ["DELETE", "/api/establishment/slots/:id", deleteSlot],
  ["GET", "/api/establishment/location", getLocation], ["PUT", "/api/establishment/location", setLocation],
  ["GET", "/api/admin/dashboard", adminDashboard],
  ["GET", "/api/admin/users", adminUsers], ["PATCH", "/api/admin/users/:id", adminUpdateUser],
  ["GET", "/api/admin/establishments", adminEstablishments], ["PATCH", "/api/admin/establishments/:id", adminUpdateEstablishment],
  ["GET", "/api/admin/reports", adminReports], ["GET", "/api/admin/reports.csv", adminReportsCsv],
].map(([method, path, handler]) => ({
  method, handler,
  re: new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "/?$"),
}));

export default async function handler(req, context) {
  const url = new URL(req.url);
  const ctx = { req, url, ip: (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "?" };
  let res;
  try {
    const matches = ROUTES.map((r) => ({ r, m: r.re.exec(url.pathname) })).filter((x) => x.m);
    if (!matches.length) {
      res = url.pathname.startsWith("/api/") ? json({ error: "Not found." }, 404) : redirect("/");
    } else {
      const hit = matches.find((x) => x.r.method === req.method);
      if (!hit) res = json({ error: "Method not allowed." }, 405);
      else {
        // State-changing API calls must carry a custom header (a cross-site page can't add it without a
        // CORS preflight), on top of SameSite=Lax cookies.
        if (url.pathname.startsWith("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
            req.headers.get("x-requested-with") !== "ParkEase") {
          throw new ApiError("Invalid request.", 403);
        }
        await ensureDb();
        res = await hit.r.handler(ctx, hit.m.groups || {});
      }
    }
  } catch (err) {
    if (err instanceof ApiError) res = json({ error: err.message }, err.status);
    else {
      console.error("Unhandled error:", err);
      res = json({ error: err.code && String(err.code).length === 5 ? "A database error occurred. Please try again." : "Something went wrong. Please try again." }, 500);
    }
  }
  const headers = new Headers(res.headers);
  if (ctx.setCookie) headers.append("Set-Cookie", ctx.setCookie);
  else if (ctx.clearCookie) headers.append("Set-Cookie", sessionCookie(ctx, "", 0));
  if (url.pathname.startsWith("/api/")) headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: res.status, headers });
}
