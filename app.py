"""ParkEase – parking reservation web app (Flask + SQLite).

Run:  python app.py      then open http://127.0.0.1:5000
"""
import csv
import hashlib
import html
import io
import json
import math
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path

from flask import (Flask, Response, g, jsonify, redirect, request, send_from_directory,
                   session)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import database as db
import mailer
import payments

BASE_DIR = Path(__file__).resolve().parent
PAGES_DIR = BASE_DIR / "pages"
PUBLIC_DIR = BASE_DIR / "public"

DT_FORMAT = db.DT_FORMAT
MIN_MINUTES = 30            # shortest reservation
MAX_DAYS_AHEAD = 60         # how far in advance a reservation can be made
RESERVED_WINDOW_HOURS = 24  # an incoming booking this close counts a slot as "Reserved"
CHECKOUT_HOLD_MINUTES = 20  # an unpaid checkout holds its slot this long
RESET_TOKEN_MINUTES = 60    # how long an e-mailed password-reset link works
# Cancelling at least this many hours before arrival is refunded in full; later cancellations are
# allowed but not refunded. Change with PARKEASE_REFUND_HOURS (0 = always refund until arrival).
REFUND_HOURS = int(os.environ.get("PARKEASE_REFUND_HOURS", "2"))

HOME_FOR_ROLE = {"user": "/user.html", "establishment": "/establishment.html", "admin": "/admin.html"}
PAGE_ROLES = {
    "user.html": "user", "user2.html": "user", "user3.html": "user", "user4.html": "user",
    "establishment.html": "establishment", "establishment2.html": "establishment",
    "establishment3.html": "establishment",
    "admin.html": "admin", "admin2.html": "admin", "admin3.html": "admin", "admin4.html": "admin",
}


def load_secret_key() -> str:
    env_key = os.environ.get("PARKEASE_SECRET_KEY")
    if env_key:
        return env_key
    db.INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    key_file = db.INSTANCE_DIR / "secret.key"
    if key_file.exists():
        return key_file.read_text().strip()
    key = secrets.token_hex(32)
    key_file.write_text(key)
    try:
        key_file.chmod(0o600)
    except OSError:
        pass
    return key


app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("PARKEASE_HTTPS") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=256 * 1024,
)

# Behind Netlify (-> host's own proxy -> Flask) the real client IP / scheme arrive in X-Forwarded-* headers.
# PARKEASE_PROXY_HOPS = how many proxies sit in front of Flask (Netlify + Render = 2). 0 = none (local).
_hops = int(os.environ.get("PARKEASE_PROXY_HOPS", "0"))
if _hops:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=_hops, x_proto=_hops, x_host=0)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify(error=err.message), err.status


@app.errorhandler(404)
def handle_404(_):
    if request.path.startswith("/api/"):
        return jsonify(error="Not found."), 404
    return redirect("/")


@app.errorhandler(405)
def handle_405(_):
    return jsonify(error="Method not allowed."), 405


@app.errorhandler(413)
def handle_413(_):
    return jsonify(error="Request too large."), 413


@app.errorhandler(sqlite3.Error)
def handle_db_error(err):
    app.logger.exception("Database error: %s", err)
    return jsonify(error="A database error occurred. Please try again."), 500


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = db.get_connection()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


@app.before_request
def csrf_guard():
    """State-changing API calls must carry a custom header (browsers block cross-site
    requests from adding it without a CORS preflight), on top of SameSite=Lax cookies."""
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path.startswith("/api/"):
        if request.headers.get("X-Requested-With") != "ParkEase":
            raise ApiError("Invalid request.", 403)


@app.after_request
def no_cache(resp):
    if request.path.startswith("/api/") or request.path.endswith(".html") or request.path == "/":
        resp.headers["Cache-Control"] = "no-store"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


def current_user():
    if "_user" in g:
        return g._user
    g._user = None
    uid = session.get("uid")
    if uid:
        row = get_db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if row and row["status"] == "Active":
            g._user = row
        else:
            session.clear()  # deleted or deactivated since login
    return g._user


def require_role(*roles):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            if not user:
                raise ApiError("Please log in to continue.", 401)
            if roles and user["role"] not in roles:
                raise ApiError("You do not have access to this.", 403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def json_body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Invalid request body.")
    return data


def clean_str(value, field, max_len, required=True) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(f"{field} is invalid.")
    value = value.strip()
    if required and not value:
        raise ApiError(f"{field} is required.")
    if len(value) > max_len:
        raise ApiError(f"{field} must be at most {max_len} characters.")
    return value


def as_int(value, field) -> int:
    try:
        if isinstance(value, bool):
            raise ValueError
        return int(value)
    except (TypeError, ValueError):
        raise ApiError(f"{field} is invalid.")


# SQL fragment computing a reservation's live state; bind :now = "YYYY-MM-DD HH:MM".
STATE_SQL = """CASE WHEN r.status = 'cancelled' THEN 'cancelled'
                     WHEN :now < r.start_at THEN 'incoming'
                     WHEN :now < r.end_at THEN 'ongoing'
                     ELSE 'completed' END"""


def now_str() -> str:
    return db.now_local().strftime(DT_FORMAT)


def user_json(u):
    return {
        "id": u["id"], "first_name": u["first_name"], "last_name": u["last_name"],
        "email": u["email"], "contact_number": u["contact_number"], "role": u["role"],
    }


def res_code(row) -> str:
    return f"RES-{row['created_at'][:4]}-{row['id']:03d}"


def money(value) -> float:
    return round(float(value or 0), 2)


def base_url() -> str:
    """Public address used in e-mailed links and payment return URLs. Set PARKEASE_BASE_URL in
    production (e.g. https://parkease.example.com) so links can't be steered by a spoofed Host header."""
    return (os.environ.get("PARKEASE_BASE_URL") or request.host_url).rstrip("/")


def notify(conn, user_id, title, body=""):
    """Queue an in-app notification (the caller commits)."""
    conn.execute("INSERT INTO notifications (user_id, title, body, created_at) VALUES (?,?,?,?)",
                 (user_id, title, body, now_str()))


def hit_rate_limit(bucket: dict, key: str, limit: int, window: int) -> bool:
    """Record one attempt for `key`; True when it has exceeded `limit` attempts in `window` seconds."""
    now = time.time()
    hits = [t for t in bucket.get(key, []) if now - t < window]
    hits.append(now)
    bucket[key] = hits
    return len(hits) > limit


# --------------------------------------------------------------------------- #
# Pages (served through role checks so protected pages need a login)
# --------------------------------------------------------------------------- #
@app.get("/")
def index_page():
    user = current_user()
    if user:
        return redirect(HOME_FOR_ROLE[user["role"]])
    return send_from_directory(PAGES_DIR, "index.html")


@app.get("/<page>.html")
def html_page(page):
    name = f"{page}.html"
    if name == "index.html":
        return redirect("/")
    if name == "reset.html":  # opened from the e-mailed link, so it must work while logged out
        return send_from_directory(PAGES_DIR, name)
    required = PAGE_ROLES.get(name)
    if required is None:
        return redirect("/")
    user = current_user()
    if not user:
        return redirect("/")
    if user["role"] != required:
        return redirect(HOME_FOR_ROLE[user["role"]])
    return send_from_directory(PAGES_DIR, name)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")
_failed_logins: dict = {}
MAX_ATTEMPTS, LOCKOUT_SECONDS = 5, 300


def _throttle_key(email: str) -> str:
    return f"{request.remote_addr}|{email.lower()}"


@app.post("/api/register")
def register():
    data = json_body()
    first = clean_str(data.get("first_name"), "First name", 50)
    last = clean_str(data.get("last_name"), "Last name", 50)
    email = clean_str(data.get("email"), "Email", 120).lower()
    contact = clean_str(data.get("contact_number"), "Contact number", 20).replace(" ", "").replace("-", "")
    password = data.get("password")
    if not EMAIL_RE.match(email):
        raise ApiError("Please enter a valid email address.")
    if not PHONE_RE.match(contact):
        raise ApiError("Please enter a valid contact number (7-15 digits).")
    if not isinstance(password, str) or len(password) < 8:
        raise ApiError("Password must be at least 8 characters.")
    if len(password) > 128:
        raise ApiError("Password is too long.")
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (first_name, last_name, email, contact_number, password_hash, role,"
            " status, created_at) VALUES (?,?,?,?,?,'user','Active',?)",
            (first, last, email, contact, generate_password_hash(password), now_str()),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise ApiError("An account with that email already exists.", 409)
    return jsonify(ok=True), 201


@app.post("/api/login")
def login():
    data = json_body()
    email = clean_str(data.get("email"), "Email", 120).lower()
    password = data.get("password")
    if not isinstance(password, str) or not password:
        raise ApiError("Password is required.")

    key, now = _throttle_key(email), time.time()
    attempts = [t for t in _failed_logins.get(key, []) if now - t < LOCKOUT_SECONDS]
    if len(attempts) >= MAX_ATTEMPTS:
        raise ApiError("Too many failed attempts. Please try again in a few minutes.", 429)

    user = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        attempts.append(now)
        _failed_logins[key] = attempts
        raise ApiError("Incorrect email or password.", 401)
    if user["status"] != "Active":
        raise ApiError("This account is inactive. Please contact the administrator.", 403)

    _failed_logins.pop(key, None)
    session.clear()
    session["uid"] = user["id"]
    session.permanent = bool(data.get("remember"))
    return jsonify(user=user_json(user), redirect=HOME_FOR_ROLE[user["role"]])


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@require_role()
def me():
    user = current_user()
    out = user_json(user)
    if user["role"] == "establishment":
        est = get_db().execute("SELECT name FROM establishments WHERE owner_id = ?", (user["id"],)).fetchone()
        out["establishment_name"] = est["name"] if est else None
    return jsonify(out)


# --------------------------------------------------------------------------- #
# Password reset by e-mail
# --------------------------------------------------------------------------- #
_reset_requests: dict = {}
_reset_attempts: dict = {}


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@app.post("/api/password/forgot")
def password_forgot():
    """Always answers the same way, so it can't be used to find out which e-mails have accounts."""
    data = json_body()
    email = clean_str(data.get("email"), "Email", 120).lower()
    if not EMAIL_RE.match(email):
        raise ApiError("Please enter a valid email address.")
    if hit_rate_limit(_reset_requests, request.remote_addr or "?", 5, 900) or \
            hit_rate_limit(_reset_requests, "mail|" + email, 3, 900):
        raise ApiError("Too many requests. Please try again in a few minutes.", 429)
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user and user["status"] == "Active":
        token = secrets.token_urlsafe(32)
        expires = db.now_local() + timedelta(minutes=RESET_TOKEN_MINUTES)
        conn.execute("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0", (user["id"],))
        conn.execute("INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?)",
                     (user["id"], _hash_token(token), expires.strftime(DT_FORMAT), now_str()))
        conn.commit()
        mailer.send_mail(
            user["email"], "Reset your ParkEase password",
            f"Hi {user['first_name']},\n\nWe received a request to reset your ParkEase password. "
            f"Open this link to choose a new one (valid for {RESET_TOKEN_MINUTES} minutes):\n\n"
            f"{base_url()}/reset.html?token={token}\n\n"
            "If you didn't ask for this, you can ignore this e-mail - your password stays the same.\n")
    return jsonify(ok=True, message="If an account exists for that email, a reset link is on its way.")


@app.post("/api/password/reset")
def password_reset():
    data = json_body()
    token = data.get("token")
    password = data.get("password")
    if hit_rate_limit(_reset_attempts, request.remote_addr or "?", 10, 900):
        raise ApiError("Too many attempts. Please try again in a few minutes.", 429)
    if not isinstance(token, str) or not token:
        raise ApiError("This reset link is invalid or has expired.")
    if not isinstance(password, str) or len(password) < 8:
        raise ApiError("Password must be at least 8 characters.")
    if len(password) > 128:
        raise ApiError("Password is too long.")
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT pr.id, pr.user_id, u.email, u.first_name, u.status FROM password_resets pr"
            " JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ? AND pr.used = 0 AND pr.expires_at >= ?",
            (_hash_token(token), now_str())).fetchone()
        if not row or row["status"] != "Active":
            raise ApiError("This reset link is invalid or has expired. Please request a new one.")
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                     (generate_password_hash(password), row["user_id"]))
        conn.execute("UPDATE password_resets SET used = 1 WHERE user_id = ?", (row["user_id"],))
        notify(conn, row["user_id"], "Password changed", "Your ParkEase password was reset.")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    _failed_logins.clear()  # a reset also clears any login lockout
    mailer.send_mail(row["email"], "Your ParkEase password was changed",
                     f"Hi {row['first_name']},\n\nYour password was just changed. If this wasn't you, "
                     "contact ParkEase support right away.\n")
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Notifications + Contact
# --------------------------------------------------------------------------- #
@app.get("/api/notifications")
@require_role()
def list_notifications():
    conn = get_db()
    uid = current_user()["id"]
    rows = conn.execute("SELECT id, title, body, is_read, created_at FROM notifications WHERE user_id = ?"
                        " ORDER BY id DESC LIMIT 30", (uid,)).fetchall()
    unread = conn.execute("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0", (uid,)).fetchone()[0]
    return jsonify(unread=unread, items=[{
        "id": n["id"], "title": n["title"], "body": n["body"], "read": bool(n["is_read"]),
        "created_at": n["created_at"]} for n in rows])


@app.post("/api/notifications/read")
@require_role()
def mark_notifications_read():
    data = json_body()
    conn = get_db()
    uid = current_user()["id"]
    if data.get("id") is None:
        conn.execute("UPDATE notifications SET is_read = 1 WHERE user_id = ?", (uid,))
    else:
        conn.execute("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?",
                     (uid, as_int(data.get("id"), "Notification")))
    conn.commit()
    return jsonify(ok=True)


_contact_sends: dict = {}


@app.post("/api/contact")
@require_role()
def contact():
    """Contact form: saved, e-mailed to the ParkEase team (reply goes straight to the sender) and shown
    to every admin as a notification."""
    data = json_body()
    user = current_user()
    subject = clean_str(data.get("subject"), "Subject", 120)
    message = clean_str(data.get("message"), "Message", 2000)
    if len(message) < 10:
        raise ApiError("Please write a little more so we can help.")
    if hit_rate_limit(_contact_sends, str(user["id"]), 5, 3600):
        raise ApiError("You've sent several messages recently. Please try again later.", 429)
    conn = get_db()
    name = f"{user['first_name']} {user['last_name']}"
    conn.execute("INSERT INTO contact_messages (user_id, name, email, subject, message, created_at)"
                 " VALUES (?,?,?,?,?,?)", (user["id"], name, user["email"], subject, message, now_str()))
    admins = conn.execute("SELECT id, email FROM users WHERE role = 'admin' AND status = 'Active'").fetchall()
    for a in admins:
        notify(conn, a["id"], f"Message from {name}", f"{subject}: {message[:160]}")
    notify(conn, user["id"], "Message sent", f"We received \"{subject}\" and will reply by email.")
    conn.commit()
    inbox = os.environ.get("PARKEASE_CONTACT_EMAIL") or (admins[0]["email"] if admins else None)
    if inbox:
        mailer.send_mail(inbox, f"[ParkEase contact] {subject}",
                         f"From: {name} <{user['email']}> ({user['role']})\n\n{message}\n",
                         reply_to=user["email"])
    return jsonify(ok=True), 201


# --------------------------------------------------------------------------- #
# Parking locations (map)
# --------------------------------------------------------------------------- #
@app.get("/api/parking-locations")
@require_role("user")
def parking_locations():
    conn = get_db()
    out = []
    for e in conn.execute("SELECT * FROM establishments WHERE status = 'Active' ORDER BY name"):
        states = slot_states(conn, e["id"])
        out.append({
            "id": e["id"], "name": e["name"], "address": e["location"], "contact_number": e["contact_number"],
            "image": e["image"], "hourly_rate": e["hourly_rate"],
            "latitude": e["latitude"], "longitude": e["longitude"],
            "total_slots": sum(1 for s in states if s["state"] != "maintenance"),
            "available_slots": sum(1 for s in states if s["state"] == "available"),
        })
    return jsonify(out)


# --------------------------------------------------------------------------- #
# Availability + pricing (shared by the customer endpoints)
# --------------------------------------------------------------------------- #
def slot_states(conn, establishment_id: int):
    """Live state of every slot: available / reserved / occupied / maintenance."""
    now = now_str()
    soon = (db.now_local() + timedelta(hours=RESERVED_WINDOW_HOURS)).strftime(DT_FORMAT)
    rows = conn.execute(
        """SELECT s.id, s.code, s.is_active,
                  EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = s.id AND r.status = 'confirmed'
                          AND r.start_at <= :now AND r.end_at > :now) AS occupied,
                  EXISTS (SELECT 1 FROM reservations r WHERE r.slot_id = s.id AND r.status = 'confirmed'
                          AND r.start_at > :now AND r.start_at <= :soon) AS reserved
           FROM parking_slots s WHERE s.establishment_id = :eid ORDER BY s.code""",
        {"now": now, "soon": soon, "eid": establishment_id},
    ).fetchall()
    out = []
    for r in rows:
        if not r["is_active"]:
            state = "maintenance"
        elif r["occupied"]:
            state = "occupied"
        elif r["reserved"]:
            state = "reserved"
        else:
            state = "available"
        out.append({"id": r["id"], "code": r["code"], "state": state, "is_active": bool(r["is_active"])})
    return out


def parse_window(data):
    """Validate date/arrival/departure from a request and return (start, end) datetimes."""
    date_s = clean_str(data.get("date"), "Date", 10)
    arr_s = clean_str(data.get("arrival"), "Arrival", 5)
    dep_s = clean_str(data.get("departure"), "Departure", 5)
    try:
        start = datetime.strptime(f"{date_s} {arr_s}", DT_FORMAT)
        end = datetime.strptime(f"{date_s} {dep_s}", DT_FORMAT)
    except ValueError:
        raise ApiError("Please enter a valid date and times.")
    now = db.now_local()
    if start < now:
        raise ApiError("Arrival time cannot be in the past.")
    if start > now + timedelta(days=MAX_DAYS_AHEAD):
        raise ApiError(f"Reservations can only be made up to {MAX_DAYS_AHEAD} days ahead.")
    if end <= start:
        raise ApiError("Departure must be after arrival.")
    if (end - start) < timedelta(minutes=MIN_MINUTES):
        raise ApiError(f"The minimum reservation is {MIN_MINUTES} minutes.")
    return start, end


def price_for(start: datetime, end: datetime, hourly_rate: float):
    minutes = int((end - start).total_seconds() // 60)
    hours = math.ceil(minutes / 60)  # partial hours are billed as a full hour
    return minutes, hours, money(hours * hourly_rate)


def load_bookable_slot(conn, slot_id: int):
    row = conn.execute(
        """SELECT s.id AS slot_id, s.code, s.is_active, e.id AS est_id, e.name, e.hourly_rate,
                  e.commission_rate, e.status AS est_status
           FROM parking_slots s JOIN establishments e ON e.id = s.establishment_id WHERE s.id = ?""",
        (slot_id,),
    ).fetchone()
    if not row or row["est_status"] != "Active":
        raise ApiError("That parking slot does not exist.", 404)
    if not row["is_active"]:
        raise ApiError("That parking slot is currently unavailable.", 409)
    return row


def slot_is_free(conn, slot_id, start: datetime, end: datetime, ignore_checkout=None) -> bool:
    """Free = no confirmed booking overlaps and nobody else is part-way through paying for it."""
    s, e = start.strftime(DT_FORMAT), end.strftime(DT_FORMAT)
    if conn.execute(
        "SELECT 1 FROM reservations WHERE slot_id = ? AND status = 'confirmed'"
        " AND start_at < ? AND end_at > ? LIMIT 1", (slot_id, e, s),
    ).fetchone():
        return False
    cutoff = (db.now_local() - timedelta(minutes=CHECKOUT_HOLD_MINUTES)).strftime(DT_FORMAT)
    held = conn.execute(
        "SELECT 1 FROM checkouts WHERE slot_id = ? AND status = 'pending' AND created_at >= ?"
        " AND start_at < ? AND end_at > ? AND id != ? LIMIT 1",
        (slot_id, cutoff, e, s, ignore_checkout or 0),
    ).fetchone()
    return held is None


# --------------------------------------------------------------------------- #
# Customer API
# --------------------------------------------------------------------------- #
@app.get("/api/establishments")
@require_role("user")
def list_establishments():
    conn = get_db()
    out = []
    for e in conn.execute("SELECT * FROM establishments WHERE status = 'Active' ORDER BY name"):
        states = slot_states(conn, e["id"])
        out.append({
            "id": e["id"], "name": e["name"], "location": e["location"], "image": e["image"],
            "hourly_rate": e["hourly_rate"],
            "total_slots": sum(1 for s in states if s["state"] != "maintenance"),
            "available_slots": sum(1 for s in states if s["state"] == "available"),
        })
    return jsonify(out)


@app.get("/api/establishments/<int:est_id>/slots")
@require_role("user")
def establishment_slots(est_id):
    """Slots for one establishment. With date/arrival/departure, each slot is flagged by whether it
    is free for that exact window; otherwise by its state right now."""
    conn = get_db()
    est = conn.execute("SELECT * FROM establishments WHERE id = ? AND status = 'Active'", (est_id,)).fetchone()
    if not est:
        raise ApiError("Establishment not found.", 404)
    slots = slot_states(conn, est_id)
    window = None
    if request.args.get("date") and request.args.get("arrival") and request.args.get("departure"):
        try:
            window = parse_window({k: request.args.get(k) for k in ("date", "arrival", "departure")})
        except ApiError:
            window = None  # incomplete/invalid window: fall back to "right now" state
    out = []
    for s in slots:
        if s["state"] == "maintenance":
            continue
        free = s["state"] == "available" if window is None else slot_is_free(conn, s["id"], *window)
        out.append({"id": s["id"], "code": s["code"], "free": free})
    return jsonify(slots=out, hourly_rate=est["hourly_rate"])


@app.post("/api/reservations/quote")
@require_role("user")
def quote_reservation():
    data = json_body()
    conn = get_db()
    slot = load_bookable_slot(conn, as_int(data.get("slot_id"), "Slot"))
    start, end = parse_window(data)
    if not slot_is_free(conn, slot["slot_id"], start, end):
        raise ApiError("That slot is already reserved for the selected time. Please pick another.", 409)
    minutes, hours, amount = price_for(start, end, slot["hourly_rate"])
    return jsonify(minutes=minutes, hours_billed=hours, hourly_rate=slot["hourly_rate"], amount=amount)


# --------------------------------------------------------------------------- #
# Payment: checkout -> gateway -> verified return/webhook -> reservation
# --------------------------------------------------------------------------- #
@app.post("/api/reservations/checkout")
@require_role("user")
def start_checkout():
    """Hold the slot and send the customer to the payment page. No reservation exists until the
    gateway confirms the payment."""
    data = json_body()
    user = current_user()
    conn = get_db()
    start, end = parse_window(data)
    slot_id = as_int(data.get("slot_id"), "Slot")
    token = secrets.token_urlsafe(24)
    try:
        conn.execute("BEGIN IMMEDIATE")  # write lock: two people cannot grab the same slot
        slot = load_bookable_slot(conn, slot_id)
        if not slot_is_free(conn, slot_id, start, end):
            raise ApiError("That slot is no longer available for the selected time. Please pick another.", 409)
        minutes, hours, amount = price_for(start, end, slot["hourly_rate"])
        if amount <= 0:
            raise ApiError("This slot has no price set, so it can't be booked online.", 409)
        cur = conn.execute(
            "INSERT INTO checkouts (token, user_id, slot_id, start_at, end_at, hours_billed, amount, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (token, user["id"], slot_id, start.strftime(DT_FORMAT), end.strftime(DT_FORMAT), hours, amount,
             now_str()),
        )
        checkout_id = cur.lastrowid
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    if payments.mode() == "mock":
        session_id, url = "mock_" + token, f"/pay/mock/{token}"
    else:
        try:
            made = payments.create_checkout(
                amount=amount, name=f"Parking at {slot['name']} (slot {slot['code']})",
                description=f"{start:%b %d, %Y} {start:%I:%M %p} - {end:%I:%M %p}, {hours} h",
                reference=f"PE-CHK-{checkout_id}",
                success_url=f"{base_url()}/payment/return?c={token}",
                cancel_url=f"{base_url()}/payment/return?c={token}&cancelled=1",
                customer_name=f"{user['first_name']} {user['last_name']}", customer_email=user["email"])
        except payments.PaymentError as exc:
            conn.execute("UPDATE checkouts SET status = 'failed' WHERE id = ?", (checkout_id,))
            conn.commit()
            app.logger.error("Checkout creation failed: %s", exc)
            raise ApiError(str(exc), 502)
        session_id, url = made["id"], made["url"]
    conn.execute("UPDATE checkouts SET session_id = ? WHERE id = ?", (session_id, checkout_id))
    conn.commit()
    return jsonify(url=url, amount=amount, minutes=minutes, mode=payments.mode()), 201


def verify_payment(co) -> dict:
    """Ask the gateway (never the browser) whether this checkout was paid."""
    if payments.mode() == "mock":
        return {"paid": bool(co["mock_paid"]), "payment_id": "mock_pay_" + co["token"], "method": "test mode"}
    if not co["session_id"]:
        return {"paid": False, "payment_id": None, "method": ""}
    return payments.get_checkout(co["session_id"])


def finalize_checkout(conn, co):
    """Turn a paid checkout into a reservation. Safe to call repeatedly (return page + webhook may both
    arrive). Returns the reservation id, or None if it was not paid / could not be honoured."""
    if co["status"] == "paid":
        return co["reservation_id"]
    if co["status"] == "failed":
        return None
    info = verify_payment(co)
    if not info["paid"]:
        return None
    start = datetime.strptime(co["start_at"], DT_FORMAT)
    end = datetime.strptime(co["end_at"], DT_FORMAT)
    conn.commit()
    try:
        conn.execute("BEGIN IMMEDIATE")
        co = conn.execute("SELECT * FROM checkouts WHERE id = ?", (co["id"],)).fetchone()
        if co["status"] == "paid":
            conn.rollback()
            return co["reservation_id"]
        try:
            slot = load_bookable_slot(conn, co["slot_id"])
            ok = slot_is_free(conn, co["slot_id"], start, end, ignore_checkout=co["id"])
        except ApiError:
            ok = False
        if not ok:
            # Paid, but the slot can no longer be given to this customer: refund automatically.
            conn.execute("UPDATE checkouts SET status = 'failed' WHERE id = ?", (co["id"],))
            note = "Your payment was received but the slot was no longer available."
            try:
                if payments.mode() == "paymongo" and info["payment_id"]:
                    payments.refund(info["payment_id"], co["amount"], "others")
                    note += " It has been refunded."
                else:
                    note += " Any payment taken will be refunded."
            except payments.PaymentError:
                note += " We could not refund automatically - please contact us."
            notify(conn, co["user_id"], "Booking could not be completed", note)
            conn.commit()
            return None
        cur = conn.execute(
            "INSERT INTO reservations (user_id, establishment_id, slot_id, start_at, end_at, hours_billed,"
            " hourly_rate, amount, commission_rate, created_at, payment_status, payment_method, payment_ref)"
            " VALUES (?,?,?,?,?,?,?,?,?,?, 'paid', ?, ?)",
            (co["user_id"], slot["est_id"], co["slot_id"], co["start_at"], co["end_at"], co["hours_billed"],
             slot["hourly_rate"], co["amount"], slot["commission_rate"], now_str(),
             info["method"] or "", info["payment_id"] or ""),
        )
        rid = cur.lastrowid
        conn.execute("UPDATE checkouts SET status = 'paid', reservation_id = ? WHERE id = ?", (rid, co["id"]))
        when = f"{start:%b %d, %Y} {start:%I:%M %p} - {end:%I:%M %p}"
        notify(conn, co["user_id"], "Booking confirmed",
               f"{slot['name']}, slot {slot['code']}, {when}. Paid {peso_text(co['amount'])}.")
        owner = conn.execute("SELECT owner_id FROM establishments WHERE id = ?", (slot["est_id"],)).fetchone()
        if owner:
            notify(conn, owner["owner_id"], "New reservation", f"Slot {slot['code']}, {when}.")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    customer = conn.execute("SELECT email, first_name FROM users WHERE id = ?", (co["user_id"],)).fetchone()
    mailer.send_mail(customer["email"], "ParkEase booking confirmed",
                     f"Hi {customer['first_name']},\n\nYour parking booking is confirmed.\n\n"
                     f"Location: {slot['name']}\nSlot: {slot['code']}\nWhen: {when}\n"
                     f"Paid: {peso_text(co['amount'])}\n\nYou can cancel from My Bookings in ParkEase.\n")
    return rid


def peso_text(amount) -> str:
    return f"PHP {float(amount):,.2f}"


@app.get("/payment/return")
def payment_return():
    """Where the payment page sends the customer back to. The redirect itself proves nothing: we ask
    the gateway whether the session was paid."""
    user = current_user()
    conn = get_db()
    co = conn.execute("SELECT * FROM checkouts WHERE token = ?", (request.args.get("c", ""),)).fetchone()
    if not user or not co or co["user_id"] != user["id"]:
        return redirect("/")
    if request.args.get("cancelled") and co["status"] == "pending":
        conn.execute("UPDATE checkouts SET status = 'expired' WHERE id = ?", (co["id"],))  # release the hold
        conn.commit()
        return redirect("/user.html?payment=cancelled")
    try:
        rid = finalize_checkout(conn, co)
    except payments.PaymentError:
        return redirect("/user3.html?payment=pending")
    if rid:
        return redirect("/user3.html?payment=success")
    co = conn.execute("SELECT status FROM checkouts WHERE id = ?", (co["id"],)).fetchone()
    return redirect("/user.html?payment=failed" if co["status"] == "failed" else "/user3.html?payment=pending")


MOCK_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Test payment</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{{font-family:system-ui,sans-serif;background:#eef2f8;display:grid;place-items:center;min-height:100vh;margin:0}}
.c{{background:#fff;padding:28px;border-radius:16px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,.15)}}
.t{{background:#fff3b4;color:#6b4e00;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:16px}}
h1{{font-size:20px;margin:0 0 6px;color:#1f4072}}.a{{font-size:32px;font-weight:700;margin:12px 0}}
button{{width:100%;padding:12px;border:0;border-radius:10px;font-size:16px;cursor:pointer;margin-top:8px}}
.p{{background:#1f4072;color:#fff}}.x{{background:#e4e8f0}}</style></head><body><div class="c">
<div class="t"><b>TEST MODE</b> - no real money moves. Set PAYMONGO_SECRET_KEY to use the real gateway.</div>
<h1>ParkEase checkout</h1><div>{what}</div><div class="a">{amount}</div>
<form method="post"><button class="p" name="result" value="pay">Simulate successful payment</button>
<button class="x" name="result" value="cancel">Cancel</button></form></div></body></html>"""


@app.route("/pay/mock/<token>", methods=["GET", "POST"])
def mock_checkout(token):
    """Stand-in for the hosted payment page, only available while no real gateway key is configured."""
    user = current_user()
    conn = get_db()
    co = conn.execute(
        """SELECT c.*, e.name AS est_name, s.code AS slot_code FROM checkouts c
           JOIN parking_slots s ON s.id = c.slot_id JOIN establishments e ON e.id = s.establishment_id
           WHERE c.token = ?""", (token,)).fetchone()
    if payments.mode() != "mock" or not user or not co or co["user_id"] != user["id"] or co["status"] != "pending":
        return redirect("/")
    if request.method == "POST":
        if request.form.get("result") == "pay":
            conn.execute("UPDATE checkouts SET mock_paid = 1 WHERE id = ?", (co["id"],))
            conn.commit()
            return redirect(f"/payment/return?c={token}")
        return redirect(f"/payment/return?c={token}&cancelled=1")
    return MOCK_PAGE.format(what=html.escape(f"{co['est_name']} - slot {co['slot_code']}"),
                            amount=html.escape(peso_text(co["amount"])))


@app.post("/webhooks/paymongo")
def paymongo_webhook():
    """Optional: lets PayMongo confirm a payment even if the customer closes the browser before being
    redirected back. Enable by setting PAYMONGO_WEBHOOK_SECRET and registering this URL in PayMongo."""
    secret = os.environ.get("PAYMONGO_WEBHOOK_SECRET", "")
    if not secret:
        return jsonify(error="Not found."), 404
    raw = request.get_data()
    if not payments.verify_webhook(raw, request.headers.get("Paymongo-Signature", ""), secret):
        return jsonify(error="Bad signature."), 400
    try:
        attrs = json.loads(raw)["data"]["attributes"]
        if attrs.get("type") == "checkout_session.payment.paid":
            session_id = attrs["data"]["id"]
            conn = get_db()
            co = conn.execute("SELECT * FROM checkouts WHERE session_id = ?", (session_id,)).fetchone()
            if co:
                finalize_checkout(conn, co)
    except (KeyError, TypeError, ValueError):
        pass  # not an event we understand; acknowledge so PayMongo doesn't keep retrying
    except payments.PaymentError:
        return jsonify(error="Try again."), 503  # let PayMongo retry
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# My bookings + cancellation
# --------------------------------------------------------------------------- #
@app.get("/api/reservations/mine")
@require_role("user")
def my_reservations():
    limit = min(max(as_int(request.args.get("limit", 10), "Limit"), 1), 100)
    # default: newest booking first (Recent Activity); sort=start: by arrival time (My Bookings)
    order = "r.start_at DESC, r.id DESC" if request.args.get("sort") == "start" else "r.created_at DESC, r.id DESC"
    rows = get_db().execute(
        f"""SELECT r.*, e.name AS est_name, e.location AS est_location, e.latitude, e.longitude,
                   s.code AS slot_code, {STATE_SQL} AS state
            FROM reservations r JOIN establishments e ON e.id = r.establishment_id
            JOIN parking_slots s ON s.id = r.slot_id
            WHERE r.user_id = :uid ORDER BY r.start_at DESC, r.id DESC LIMIT :limit""",
        {"now": now_str(), "uid": current_user()["id"], "limit": limit},
    ).fetchall()
    now = db.now_local()
    out = []
    for r in rows:
        start = datetime.strptime(r["start_at"], DT_FORMAT)
        out.append({
            "id": r["id"], "code": res_code(r), "location": r["est_name"], "address": r["est_location"],
            "slot": r["slot_code"], "start_at": r["start_at"], "end_at": r["end_at"],
            "amount": r["amount"], "status": r["state"], "payment_status": r["payment_status"],
            "can_cancel": r["state"] == "incoming",
            "refundable": r["state"] == "incoming" and start - now >= timedelta(hours=REFUND_HOURS),
            "latitude": r["latitude"], "longitude": r["longitude"], "refund_hours": REFUND_HOURS,
        })
    return jsonify(out)


@app.post("/api/reservations/<int:res_id>/cancel")
@require_role("user")
def cancel_reservation(res_id):
    user = current_user()
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        r = conn.execute(
            """SELECT r.*, e.name AS est_name, e.owner_id, s.code AS slot_code FROM reservations r
               JOIN establishments e ON e.id = r.establishment_id JOIN parking_slots s ON s.id = r.slot_id
               WHERE r.id = ? AND r.user_id = ?""", (res_id, user["id"])).fetchone()
        if not r:
            raise ApiError("Reservation not found.", 404)
        if r["status"] == "cancelled":
            raise ApiError("This reservation is already cancelled.", 409)
        start = datetime.strptime(r["start_at"], DT_FORMAT)
        now = db.now_local()
        if start <= now:
            raise ApiError("This reservation has already started, so it can't be cancelled.", 409)

        refundable = start - now >= timedelta(hours=REFUND_HOURS)
        if not refundable:
            pay_status = "no_refund"
        elif payments.mode() == "mock":
            pay_status = "refunded"
        elif r["payment_ref"]:
            try:
                pay_status = "refunded" if payments.refund(r["payment_ref"], r["amount"]) == "succeeded" \
                    else "refund_pending"
            except payments.PaymentError as exc:  # keep the booking so the customer can retry
                raise ApiError(f"The refund could not be processed, so the booking was not cancelled. {exc}", 502)
        else:
            pay_status = "refund_pending"  # paid outside the gateway (e.g. demo data): staff refund manually
        conn.execute("UPDATE reservations SET status = 'cancelled', cancelled_at = ?, payment_status = ?"
                     " WHERE id = ?", (now_str(), pay_status, res_id))
        when = f"{start:%b %d, %Y} {start:%I:%M %p}"
        refund_text = {"refunded": f"{peso_text(r['amount'])} is being refunded to your original payment method.",
                       "refund_pending": "Your refund is being processed.",
                       "no_refund": f"It was cancelled less than {REFUND_HOURS} hour(s) before arrival, "
                                    "so it is not refundable."}[pay_status]
        notify(conn, user["id"], "Booking cancelled",
               f"{r['est_name']}, slot {r['slot_code']}, {when}. {refund_text}")
        notify(conn, r["owner_id"], "Reservation cancelled", f"Slot {r['slot_code']}, {when} was cancelled.")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    mailer.send_mail(user["email"], "ParkEase booking cancelled",
                     f"Hi {user['first_name']},\n\nYour booking at {r['est_name']} (slot {r['slot_code']}) on "
                     f"{when} has been cancelled.\n{refund_text}\n")
    return jsonify(ok=True, payment_status=pay_status, message=refund_text)


# --------------------------------------------------------------------------- #
# Establishment API
# --------------------------------------------------------------------------- #
def my_establishment(conn):
    est = conn.execute("SELECT * FROM establishments WHERE owner_id = ?", (current_user()["id"],)).fetchone()
    if not est:
        raise ApiError("No establishment is linked to this account.", 404)
    return est


@app.get("/api/establishment/overview")
@require_role("establishment")
def establishment_overview():
    conn = get_db()
    est = my_establishment(conn)
    counts = {"incoming": 0, "ongoing": 0, "completed": 0}
    revenue = 0.0
    for r in conn.execute(
        f"SELECT r.amount, {STATE_SQL} AS state FROM reservations r WHERE r.establishment_id = :eid",
        {"now": now_str(), "eid": est["id"]},
    ):
        if r["state"] != "cancelled":
            counts[r["state"]] += 1
            revenue += r["amount"]
    states = [s["state"] for s in slot_states(conn, est["id"])]
    return jsonify(
        name=est["name"], revenue=money(revenue),
        # "Incoming" = every booking that has not finished yet (upcoming + in progress)
        reservations_total=sum(counts.values()),
        incoming=counts["incoming"] + counts["ongoing"], completed=counts["completed"],
        slots_available=states.count("available"), slots_reserved=states.count("reserved"),
        slots_occupied=states.count("occupied"),
    )


@app.get("/api/establishment/reservations")
@require_role("establishment")
def establishment_reservations():
    conn = get_db()
    est = my_establishment(conn)
    rows = conn.execute(
        f"""SELECT r.*, u.first_name, u.last_name, s.code AS slot_code, {STATE_SQL} AS state
            FROM reservations r JOIN users u ON u.id = r.user_id JOIN parking_slots s ON s.id = r.slot_id
            WHERE r.establishment_id = :eid ORDER BY r.start_at DESC, r.id DESC""",
        {"now": now_str(), "eid": est["id"]},
    ).fetchall()
    return jsonify([{
        "id": r["id"], "code": res_code(r), "customer": f"{r['first_name']} {r['last_name']}",
        "slot": r["slot_code"], "start_at": r["start_at"], "end_at": r["end_at"],
        "amount": r["amount"], "status": r["state"],
    } for r in rows])


@app.get("/api/establishment/slots")
@require_role("establishment")
def establishment_slot_list():
    conn = get_db()
    est = my_establishment(conn)
    return jsonify(slots=slot_states(conn, est["id"]))


@app.get("/api/establishment/location")
@require_role("establishment")
def get_location():
    est = my_establishment(get_db())
    return jsonify(address=est["location"], latitude=est["latitude"], longitude=est["longitude"])


@app.put("/api/establishment/location")
@require_role("establishment")
def set_location():
    """Where customers find this establishment on the map."""
    data = json_body()
    conn = get_db()
    est = my_establishment(conn)
    try:
        lat, lng = float(data.get("latitude")), float(data.get("longitude"))
    except (TypeError, ValueError):
        raise ApiError("Latitude and longitude must be numbers.")
    if not (math.isfinite(lat) and math.isfinite(lng)) or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ApiError("That latitude/longitude is out of range.")
    address = clean_str(data.get("address", est["location"]), "Address", 160)
    conn.execute("UPDATE establishments SET latitude = ?, longitude = ?, location = ? WHERE id = ?",
                 (lat, lng, address, est["id"]))
    conn.commit()
    return jsonify(ok=True)


SLOT_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,14}$")


@app.post("/api/establishment/slots")
@require_role("establishment")
def add_slot():
    conn = get_db()
    est = my_establishment(conn)
    code = clean_str(json_body().get("code"), "Slot code", 15).upper()
    if not SLOT_CODE_RE.match(code):
        raise ApiError("Slot code may only contain letters, numbers, spaces, - and _.")
    try:
        conn.execute("INSERT INTO parking_slots (establishment_id, code) VALUES (?, ?)", (est["id"], code))
        conn.commit()
    except sqlite3.IntegrityError:
        raise ApiError(f"Slot {code} already exists.", 409)
    return jsonify(ok=True), 201


def own_slot(conn, slot_id):
    est = my_establishment(conn)
    slot = conn.execute("SELECT * FROM parking_slots WHERE id = ? AND establishment_id = ?",
                        (slot_id, est["id"])).fetchone()
    if not slot:
        raise ApiError("Slot not found.", 404)
    return slot


@app.patch("/api/establishment/slots/<int:slot_id>")
@require_role("establishment")
def update_slot(slot_id):
    conn = get_db()
    own_slot(conn, slot_id)
    active = json_body().get("is_active")
    if not isinstance(active, bool):
        raise ApiError("is_active must be true or false.")
    conn.execute("UPDATE parking_slots SET is_active = ? WHERE id = ?", (1 if active else 0, slot_id))
    conn.commit()
    return jsonify(ok=True)


@app.delete("/api/establishment/slots/<int:slot_id>")
@require_role("establishment")
def delete_slot(slot_id):
    conn = get_db()
    own_slot(conn, slot_id)
    if conn.execute("SELECT 1 FROM reservations WHERE slot_id = ? LIMIT 1", (slot_id,)).fetchone():
        raise ApiError("This slot has reservation history, so it can't be deleted. "
                       "Set it to maintenance instead.", 409)
    conn.execute("DELETE FROM parking_slots WHERE id = ?", (slot_id,))
    conn.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Admin API
# --------------------------------------------------------------------------- #
def establishment_stats(conn):
    """One row per establishment: booking count, revenue and commission (cancelled excluded)."""
    return conn.execute(
        """SELECT e.id, e.name, e.location, e.contact_number, e.status, e.commission_rate,
                  COUNT(r.id) AS reservations,
                  COALESCE(SUM(r.amount), 0) AS revenue,
                  COALESCE(SUM(r.amount * r.commission_rate / 100.0), 0) AS commission
           FROM establishments e
           LEFT JOIN reservations r ON r.establishment_id = e.id AND r.status = 'confirmed'
           GROUP BY e.id ORDER BY e.id"""
    ).fetchall()


@app.get("/api/admin/dashboard")
@require_role("admin")
def admin_dashboard():
    conn = get_db()
    stats = establishment_stats(conn)
    return jsonify(
        total_commission=money(sum(s["commission"] for s in stats)),
        total_users=conn.execute("SELECT COUNT(*) FROM users WHERE role = 'user'").fetchone()[0],
        total_establishments=len(stats),
        establishments=[{
            "name": s["name"], "reservations": s["reservations"], "revenue": money(s["revenue"]),
            "commission_rate": s["commission_rate"], "commission": money(s["commission"]),
        } for s in stats],
    )


@app.get("/api/admin/users")
@require_role("admin")
def admin_users():
    rows = get_db().execute(
        "SELECT * FROM users WHERE role = 'user' ORDER BY id"
    ).fetchall()
    return jsonify([{
        "id": u["id"], "code": f"USR-{u['id']:03d}", "name": f"{u['first_name']} {u['last_name']}",
        "email": u["email"], "contact_number": u["contact_number"],
        "created_at": u["created_at"][:10], "status": u["status"],
    } for u in rows])


def read_status(data) -> str:
    status = data.get("status")
    if status not in ("Active", "Inactive"):
        raise ApiError("Status must be Active or Inactive.")
    return status


@app.patch("/api/admin/users/<int:user_id>")
@require_role("admin")
def admin_update_user(user_id):
    status = read_status(json_body())
    conn = get_db()
    cur = conn.execute("UPDATE users SET status = ? WHERE id = ? AND role = 'user'", (status, user_id))
    conn.commit()
    if cur.rowcount == 0:
        raise ApiError("User not found.", 404)
    return jsonify(ok=True)


@app.get("/api/admin/establishments")
@require_role("admin")
def admin_establishments():
    return jsonify([{
        "id": s["id"], "code": f"EST-{s['id']:03d}", "name": s["name"], "location": s["location"],
        "contact_number": s["contact_number"], "reservations": s["reservations"], "status": s["status"],
    } for s in establishment_stats(get_db())])


@app.patch("/api/admin/establishments/<int:est_id>")
@require_role("admin")
def admin_update_establishment(est_id):
    status = read_status(json_body())
    conn = get_db()
    cur = conn.execute("UPDATE establishments SET status = ? WHERE id = ?", (status, est_id))
    conn.commit()
    if cur.rowcount == 0:
        raise ApiError("Establishment not found.", 404)
    return jsonify(ok=True)


def report_data(conn, months: int):
    # Walk back so we cover `months` calendar months including the current one.
    start = db.now_local().replace(day=1)
    for _ in range(months - 1):
        start = (start - timedelta(days=1)).replace(day=1)
    by_month = conn.execute(
        """SELECT substr(start_at, 1, 7) AS month, COUNT(*) AS reservations,
                  SUM(amount) AS revenue, SUM(amount * commission_rate / 100.0) AS commission
           FROM reservations WHERE status = 'confirmed' AND start_at >= ?
           GROUP BY month ORDER BY month DESC""",
        (start.strftime("%Y-%m-01 00:00"),),
    ).fetchall()
    return start.strftime("%Y-%m"), by_month, establishment_stats(conn)


@app.get("/api/admin/reports")
@require_role("admin")
def admin_reports():
    months = min(max(as_int(request.args.get("months", 6), "Months"), 1), 24)
    conn = get_db()
    since, by_month, stats = report_data(conn, months)
    return jsonify(
        since=since,
        months=[{"month": m["month"], "reservations": m["reservations"], "revenue": money(m["revenue"]),
                 "commission": money(m["commission"])} for m in by_month],
        establishments=[{"name": s["name"], "reservations": s["reservations"], "revenue": money(s["revenue"]),
                         "commission_rate": s["commission_rate"], "commission": money(s["commission"])}
                        for s in stats],
    )


def csv_safe(value):
    """Neutralise spreadsheet formula injection in exported text cells."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


@app.get("/api/admin/reports.csv")
@require_role("admin")
def admin_reports_csv():
    conn = get_db()
    rows = conn.execute(
        f"""SELECT r.id, r.created_at, e.name AS est, s.code AS slot, u.first_name, u.last_name,
                   r.start_at, r.end_at, r.hours_billed, r.amount, r.commission_rate,
                   r.amount * r.commission_rate / 100.0 AS commission, {STATE_SQL} AS state
            FROM reservations r JOIN establishments e ON e.id = r.establishment_id
            JOIN parking_slots s ON s.id = r.slot_id JOIN users u ON u.id = r.user_id
            ORDER BY r.start_at DESC""",
        {"now": now_str()},
    ).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Reservation", "Establishment", "Slot", "Customer", "Start", "End", "Hours billed",
                "Amount", "Commission %", "Commission", "Status"])
    for r in rows:
        w.writerow([res_code(r), csv_safe(r["est"]), csv_safe(r["slot"]),
                    csv_safe(f"{r['first_name']} {r['last_name']}"), r["start_at"], r["end_at"],
                    r["hours_billed"], f"{r['amount']:.2f}", r["commission_rate"],
                    f"{r['commission']:.2f}", r["state"]])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=parkease-reservations.csv"})


# --------------------------------------------------------------------------- #
def check_payment_setup():
    """The built-in test checkout moves no money, so it must never be live on a real site."""
    if payments.mode() != "mock":
        return
    if os.environ.get("PARKEASE_HTTPS") == "1" and os.environ.get("PARKEASE_MOCK_PAYMENTS") != "1":
        raise RuntimeError("PARKEASE_HTTPS=1 but PAYMONGO_SECRET_KEY is not set: refusing to start with the "
                           "fake test checkout, which would let anyone book for free. Set PAYMONGO_SECRET_KEY "
                           "(or PARKEASE_MOCK_PAYMENTS=1 if you really want the test checkout).")
    app.logger.warning("PAYMENTS ARE IN TEST MODE: no real money is charged. Set PAYMONGO_SECRET_KEY to accept "
                       "real payments.")
    if not mailer.is_configured():
        app.logger.warning("E-mail is not configured: password-reset and notification e-mails are written to "
                           "instance/outbox.log instead of being sent. Set PARKEASE_SMTP_HOST etc.")


check_payment_setup()
db.init_db(seed_demo=os.environ.get("PARKEASE_SEED_DEMO", "1") != "0")

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)),
            debug=os.environ.get("FLASK_DEBUG") == "1")
