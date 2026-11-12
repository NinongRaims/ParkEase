"""ParkEase database layer (SQLite).

Run directly to (re)build the database:

    python database.py            # create tables + demo data if the DB is empty
    python database.py --reset    # delete the DB and rebuild it with demo data
    python database.py --empty    # create tables only (no demo data)
"""
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from werkzeug.security import generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
INSTANCE_DIR = BASE_DIR / "instance"
DB_PATH = Path(os.environ.get("PARKEASE_DB", INSTANCE_DIR / "parkease.db"))

TZ = ZoneInfo(os.environ.get("PARKEASE_TZ", "Asia/Manila"))
DT_FORMAT = "%Y-%m-%d %H:%M"  # reservation times are stored as local "YYYY-MM-DD HH:MM"


def now_local() -> datetime:
    """Current local time (naive, minute precision) in the configured timezone."""
    return datetime.now(TZ).replace(tzinfo=None, second=0, microsecond=0)


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name     TEXT    NOT NULL,
    last_name      TEXT    NOT NULL,
    email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    contact_number TEXT    NOT NULL DEFAULT '',
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL CHECK (role IN ('user', 'establishment', 'admin')),
    status         TEXT    NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS establishments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    name            TEXT    NOT NULL,
    location        TEXT    NOT NULL,
    contact_number  TEXT    NOT NULL DEFAULT '',
    image           TEXT    NOT NULL DEFAULT '',
    latitude        REAL,
    longitude       REAL,
    hourly_rate     REAL    NOT NULL CHECK (hourly_rate >= 0),
    commission_rate REAL    NOT NULL DEFAULT 10 CHECK (commission_rate >= 0 AND commission_rate <= 100),
    status          TEXT    NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    created_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS parking_slots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    establishment_id INTEGER NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    code             TEXT    NOT NULL,
    is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    UNIQUE (establishment_id, code)
);

CREATE TABLE IF NOT EXISTS reservations (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    establishment_id  INTEGER NOT NULL REFERENCES establishments(id) ON DELETE RESTRICT,
    slot_id           INTEGER NOT NULL REFERENCES parking_slots(id) ON DELETE RESTRICT,
    start_at          TEXT    NOT NULL,           -- 'YYYY-MM-DD HH:MM' local time
    end_at            TEXT    NOT NULL,
    hours_billed      INTEGER NOT NULL,
    hourly_rate       REAL    NOT NULL,           -- snapshot of the rate when booked
    amount            REAL    NOT NULL,
    commission_rate   REAL    NOT NULL,           -- snapshot of the commission % when booked
    status            TEXT    NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
    created_at        TEXT    NOT NULL,
    payment_status    TEXT    NOT NULL DEFAULT 'paid',   -- paid | refunded | refund_pending | no_refund
    payment_method    TEXT    NOT NULL DEFAULT '',
    payment_ref       TEXT    NOT NULL DEFAULT '',       -- gateway payment id (used for refunds)
    cancelled_at      TEXT    NOT NULL DEFAULT '',
    CHECK (end_at > start_at)
);

-- A booking only becomes a reservation once the gateway confirms payment. Until then it lives here and
-- holds the slot for CHECKOUT_HOLD_MINUTES.
CREATE TABLE IF NOT EXISTS checkouts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT    NOT NULL UNIQUE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_id       INTEGER NOT NULL REFERENCES parking_slots(id) ON DELETE CASCADE,
    start_at      TEXT    NOT NULL,
    end_at        TEXT    NOT NULL,
    hours_billed  INTEGER NOT NULL,
    amount        REAL    NOT NULL,
    session_id    TEXT    NOT NULL DEFAULT '',   -- PayMongo checkout session id (or mock id)
    status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
    mock_paid     INTEGER NOT NULL DEFAULT 0,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
    created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkout_session ON checkouts (session_id);

CREATE TABLE IF NOT EXISTS password_resets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL UNIQUE,      -- only a hash is stored, the e-mailed token is the secret
    expires_at  TEXT    NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    body        TEXT    NOT NULL DEFAULT '',
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, is_read, id);

CREATE TABLE IF NOT EXISTS contact_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL,
    subject     TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_res_slot_time ON reservations (slot_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_res_user      ON reservations (user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_res_est       ON reservations (establishment_id, start_at);
"""


def get_connection() -> sqlite3.Connection:
    INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


DEMO_COORDS = [("CityWalk Tarlac", 15.4755, 120.5963), ("SM City Tarlac", 15.4838, 120.5890)]

MIGRATIONS = {  # columns added after the first release: (table, column, definition)
    ("establishments", "latitude", "REAL"),
    ("establishments", "longitude", "REAL"),
    ("reservations", "payment_status", "TEXT NOT NULL DEFAULT 'paid'"),
    ("reservations", "payment_method", "TEXT NOT NULL DEFAULT ''"),
    ("reservations", "payment_ref", "TEXT NOT NULL DEFAULT ''"),
    ("reservations", "cancelled_at", "TEXT NOT NULL DEFAULT ''"),
}


def migrate(conn: sqlite3.Connection) -> None:
    """Upgrade a database created by an older version (adds any missing columns)."""
    for table, column, definition in sorted(MIGRATIONS):
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if cols and column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    # Databases made before maps existed: give the two demo establishments their (approximate) pins.
    for name, lat, lng in DEMO_COORDS:
        conn.execute("UPDATE establishments SET latitude = ?, longitude = ? "
                     "WHERE name = ? AND latitude IS NULL", (lat, lng, name))


def init_db(seed_demo: bool = True) -> None:
    """Create tables; load demo data only when the database has no users yet."""
    conn = get_connection()
    try:
        conn.executescript(SCHEMA)
        migrate(conn)
        empty = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        if seed_demo and empty:
            seed_demo_data(conn)
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Demo data
# --------------------------------------------------------------------------- #
DEMO_PASSWORDS = {"admin": "admin123", "establishment": "owner123", "user": "user123"}


def _fmt(dt: datetime) -> str:
    return dt.strftime(DT_FORMAT)


def seed_demo_data(conn: sqlite3.Connection) -> None:
    now = now_local()
    # Round "now" down to the half hour so seeded times look tidy.
    base = now.replace(minute=0 if now.minute < 30 else 30)
    created = _fmt(now)

    def add_user(first, last, email, contact, role, password, status="Active", days_ago=10):
        cur = conn.execute(
            "INSERT INTO users (first_name, last_name, email, contact_number, password_hash,"
            " role, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (first, last, email, contact, generate_password_hash(password), role, status,
             _fmt(now - timedelta(days=days_ago))),
        )
        return cur.lastrowid

    add_user("System", "Admin", "admin@parkease.com", "", "admin", DEMO_PASSWORDS["admin"], days_ago=60)

    customers = [
        add_user("Juan", "Dela Cruz", "juan@email.com", "09171234567", "user", DEMO_PASSWORDS["user"], days_ago=9),
        add_user("Maria", "Santos", "maria@email.com", "09181234567", "user", DEMO_PASSWORDS["user"], days_ago=7),
        add_user("Pedro", "Reyes", "pedro@email.com", "09191234567", "user", DEMO_PASSWORDS["user"], "Inactive", days_ago=5),
        add_user("Ana", "Lim", "ana@email.com", "09201234567", "user", DEMO_PASSWORDS["user"], days_ago=3),
    ]

    establishments = [
        # name, location, contact, image, rate/hr, commission %, owner e-mail, slot codes, (lat, lng)
        # Coordinates are approximate demo values - the owner/admin should set the exact pin.
        ("CityWalk Tarlac", "Tarlac City, Tarlac", "09171230001", "Images/Establishment1.webp", 40, 10,
         "citywalk@parkease.com", [f"{r}-{n:02d}" for r in "AB" for n in range(1, 11)], (15.4755, 120.5963)),
        ("SM City Tarlac", "San Roque, Tarlac City", "09171230002", "Images/Establishment2.webp", 50, 12,
         "smtarlac@parkease.com", [f"{r}-{n:02d}" for r in "AB" for n in range(1, 9)], (15.4838, 120.5890)),
    ]

    est_ids, slot_ids = [], []
    for name, loc, contact, image, rate, comm, email, codes, (lat, lng) in establishments:
        owner = add_user(name.split()[0], "Manager", email, contact, "establishment",
                         DEMO_PASSWORDS["establishment"], days_ago=40)
        eid = conn.execute(
            "INSERT INTO establishments (owner_id, name, location, contact_number, image,"
            " hourly_rate, commission_rate, latitude, longitude, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (owner, name, loc, contact, image, rate, comm, lat, lng, created),
        ).lastrowid
        est_ids.append(eid)
        ids = []
        for code in codes:
            ids.append(conn.execute(
                "INSERT INTO parking_slots (establishment_id, code) VALUES (?, ?)", (eid, code)
            ).lastrowid)
        slot_ids.append(ids)

    def book(est_idx, slot_idx, user_idx, start_offset_min, duration_min):
        start = base + timedelta(minutes=start_offset_min)
        end = start + timedelta(minutes=duration_min)
        rate, comm = establishments[est_idx][4], establishments[est_idx][5]
        hours = -(-duration_min // 60)
        conn.execute(
            "INSERT INTO reservations (user_id, establishment_id, slot_id, start_at, end_at,"
            " hours_billed, hourly_rate, amount, commission_rate, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (customers[user_idx], est_ids[est_idx], slot_ids[est_idx][slot_idx], _fmt(start),
             _fmt(end), hours, rate, hours * rate, comm, _fmt(start - timedelta(days=1))),
        )

    day = 24 * 60
    # (establishment, slot, user, start offset in minutes from "now", duration in minutes)
    demo = [
        # --- completed (past) ---
        (0, 0, 0, -3 * day, 120), (0, 1, 1, -3 * day + 30, 180), (0, 2, 3, -2 * day, 60),
        (0, 3, 0, -2 * day + 60, 240), (0, 0, 1, -day, 90), (0, 4, 3, -day, 120),
        (0, 5, 0, -5 * day, 60), (0, 6, 1, -4 * day, 150), (0, 7, 3, -4 * day, 120),
        (1, 0, 0, -3 * day, 120), (1, 1, 1, -2 * day, 60), (1, 2, 3, -day, 180),
        (1, 3, 0, -day + 90, 120),
        # --- ongoing right now (started in the last hour, ends in the future) ---
        (0, 8, 0, -45, 150), (0, 9, 1, -30, 120), (0, 10, 3, -60, 180),
        (0, 11, 0, -30, 90), (0, 12, 1, -15, 120),
        (1, 4, 3, -40, 120), (1, 5, 0, -30, 150),
        # --- incoming within the next 24h (shows as "Reserved") ---
        (0, 13, 1, 60, 120), (0, 14, 3, 90, 60), (0, 15, 0, 120, 180), (0, 16, 1, 180, 120),
        (0, 17, 3, 240, 60), (0, 18, 0, 300, 120), (0, 19, 1, 360, 120),
        (1, 6, 1, 90, 120), (1, 7, 3, 150, 60), (1, 8, 0, 210, 120),
        # --- incoming later (not yet "Reserved") ---
        (0, 0, 0, 2 * day, 120), (0, 1, 3, 2 * day + 60, 180), (0, 2, 1, 3 * day, 60),
        (1, 0, 1, 2 * day, 120), (1, 1, 3, 4 * day, 90),
    ]
    for row in demo:
        book(*row)

    # One cancelled booking so reports/filters have something to exclude.
    start = base + timedelta(days=1)
    conn.execute(
        "INSERT INTO reservations (user_id, establishment_id, slot_id, start_at, end_at, hours_billed,"
        " hourly_rate, amount, commission_rate, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (customers[0], est_ids[0], slot_ids[0][5], _fmt(start), _fmt(start + timedelta(hours=2)),
         2, 40, 80, 10, "cancelled", created),
    )


if __name__ == "__main__":
    args = set(sys.argv[1:])
    if "--reset" in args:
        for suffix in ("", "-wal", "-shm"):
            Path(str(DB_PATH) + suffix).unlink(missing_ok=True)
    init_db(seed_demo="--empty" not in args)
    print(f"Database ready at {DB_PATH}")
