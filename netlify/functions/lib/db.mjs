// Postgres access (Netlify DB / Neon, or any Postgres via DATABASE_URL), schema creation and demo data.
import pg from "pg";
import { hashPassword } from "./security.mjs";
import { addMinutes, fmt, nowLocal } from "./util.mjs";

let pool;
export function getPool() {
  if (!pool) {
    const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("No database configured: set up Netlify DB or set DATABASE_URL.");
    pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
    pool.on("error", (e) => console.error("Postgres pool error:", e.message));
  }
  return pool;
}

export const all = async (db, text, params = []) => (await db.query(text, params)).rows;
export const one = async (db, text, params = []) => (await db.query(text, params)).rows[0] || null;

/** Runs fn(client) in a transaction. A global advisory lock serialises booking/payment writes, which is
    what keeps two people from grabbing the same slot (the Flask version used SQLite's write lock). */
export async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7314)");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact_number TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','establishment','admin')),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS establishments (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, location TEXT NOT NULL,
  contact_number TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  hourly_rate DOUBLE PRECISION NOT NULL CHECK (hourly_rate >= 0),
  commission_rate DOUBLE PRECISION NOT NULL DEFAULT 10 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parking_slots (
  id SERIAL PRIMARY KEY,
  establishment_id INTEGER NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  UNIQUE (establishment_id, code)
);

CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  establishment_id INTEGER NOT NULL REFERENCES establishments(id) ON DELETE RESTRICT,
  slot_id INTEGER NOT NULL REFERENCES parking_slots(id) ON DELETE RESTRICT,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  hours_billed INTEGER NOT NULL,
  hourly_rate DOUBLE PRECISION NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  commission_rate DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  created_at TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'paid',
  payment_method TEXT NOT NULL DEFAULT '',
  payment_ref TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT NOT NULL DEFAULT '',
  CHECK (end_at > start_at)
);

CREATE TABLE IF NOT EXISTS checkouts (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES parking_slots(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  hours_billed INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired')),
  mock_paid INTEGER NOT NULL DEFAULT 0,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkout_session ON checkouts (session_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, is_read, id);

CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_res_slot_time ON reservations (slot_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_res_user ON reservations (user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_res_est ON reservations (establishment_id, start_at);
`;

let ready;
/** Creates the tables (and demo data on an empty database) once per warm function instance. */
export function ensureDb() {
  if (!ready) {
    ready = initDb().catch((err) => { ready = undefined; throw err; });
  }
  return ready;
}

async function initDb() {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(7315)");   // two cold starts must not both seed
    await client.query(SCHEMA);
    const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM users");
    if (rows[0].n === 0) {
      if (process.env.PARKEASE_SEED_DEMO !== "0") await seedDemoData(client);
    }
    // Lets you create the first admin on a database without demo data.
    const adminEmail = (process.env.PARKEASE_ADMIN_EMAIL || "").trim().toLowerCase();
    const adminPass = process.env.PARKEASE_ADMIN_PASSWORD || "";
    if (adminEmail && adminPass.length >= 8) {
      const has = await client.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
      if (!has.rowCount) {
        await client.query(
          "INSERT INTO users (first_name,last_name,email,contact_number,password_hash,role,status,created_at)" +
          " VALUES ('System','Admin',$1,'',$2,'admin','Active',$3) ON CONFLICT DO NOTHING",
          [adminEmail, await hashPassword(adminPass), fmt(nowLocal())]);
      }
    }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(7315)"); } catch { /* ignore */ }
    client.release();
  }
}

const DEMO_PASSWORDS = { admin: "admin123", establishment: "owner123", user: "user123" };

async function seedDemoData(c) {
  const now = nowLocal();
  const base = new Date(now); base.setUTCMinutes(now.getUTCMinutes() < 30 ? 0 : 30);
  const created = fmt(now);
  const day = 24 * 60;
  const hashes = {};
  for (const [role, pw] of Object.entries(DEMO_PASSWORDS)) hashes[role] = await hashPassword(pw);

  const addUser = async (first, last, email, contact, role, status = "Active", daysAgo = 10) =>
    (await c.query(
      "INSERT INTO users (first_name,last_name,email,contact_number,password_hash,role,status,created_at)" +
      " VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [first, last, email, contact, hashes[role], role, status, fmt(addMinutes(now, -daysAgo * day))])).rows[0].id;

  await addUser("System", "Admin", "admin@parkease.com", "", "admin", "Active", 60);
  const customers = [
    await addUser("Juan", "Dela Cruz", "juan@email.com", "09171234567", "user", "Active", 9),
    await addUser("Maria", "Santos", "maria@email.com", "09181234567", "user", "Active", 7),
    await addUser("Pedro", "Reyes", "pedro@email.com", "09191234567", "user", "Inactive", 5),
    await addUser("Ana", "Lim", "ana@email.com", "09201234567", "user", "Active", 3),
  ];
  const codes = (letters, n) => [...letters].flatMap((r) => Array.from({ length: n }, (_, i) => `${r}-${String(i + 1).padStart(2, "0")}`));
  const establishments = [
    { name: "CityWalk Tarlac", loc: "Tarlac City, Tarlac", contact: "09171230001", image: "Images/Establishment1.webp",
      rate: 40, comm: 10, email: "citywalk@parkease.com", slots: codes("AB", 10), lat: 15.4755, lng: 120.5963 },
    { name: "SM City Tarlac", loc: "San Roque, Tarlac City", contact: "09171230002", image: "Images/Establishment2.webp",
      rate: 50, comm: 12, email: "smtarlac@parkease.com", slots: codes("AB", 8), lat: 15.4838, lng: 120.5890 },
  ];
  const estIds = [], slotIds = [];
  for (const e of establishments) {
    const owner = await addUser(e.name.split(" ")[0], "Manager", e.email, e.contact, "establishment", "Active", 40);
    const eid = (await c.query(
      "INSERT INTO establishments (owner_id,name,location,contact_number,image,hourly_rate,commission_rate,latitude,longitude,created_at)" +
      " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
      [owner, e.name, e.loc, e.contact, e.image, e.rate, e.comm, e.lat, e.lng, created])).rows[0].id;
    estIds.push(eid);
    const ids = [];
    for (const code of e.slots) {
      ids.push((await c.query("INSERT INTO parking_slots (establishment_id, code) VALUES ($1,$2) RETURNING id", [eid, code])).rows[0].id);
    }
    slotIds.push(ids);
  }

  const book = async (ei, si, ui, startOffset, duration) => {
    const start = addMinutes(base, startOffset), end = addMinutes(start, duration);
    const { rate, comm } = establishments[ei];
    const hours = Math.ceil(duration / 60);
    await c.query(
      "INSERT INTO reservations (user_id,establishment_id,slot_id,start_at,end_at,hours_billed,hourly_rate,amount,commission_rate,created_at)" +
      " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [customers[ui], estIds[ei], slotIds[ei][si], fmt(start), fmt(end), hours, rate, hours * rate, comm, fmt(addMinutes(start, -day))]);
  };
  // [establishment, slot, user, start offset (min from now), duration (min)]
  const demo = [
    [0,0,0,-3*day,120],[0,1,1,-3*day+30,180],[0,2,3,-2*day,60],[0,3,0,-2*day+60,240],[0,0,1,-day,90],[0,4,3,-day,120],
    [0,5,0,-5*day,60],[0,6,1,-4*day,150],[0,7,3,-4*day,120],[1,0,0,-3*day,120],[1,1,1,-2*day,60],[1,2,3,-day,180],[1,3,0,-day+90,120],
    [0,8,0,-45,150],[0,9,1,-30,120],[0,10,3,-60,180],[0,11,0,-30,90],[0,12,1,-15,120],[1,4,3,-40,120],[1,5,0,-30,150],
    [0,13,1,60,120],[0,14,3,90,60],[0,15,0,120,180],[0,16,1,180,120],[0,17,3,240,60],[0,18,0,300,120],[0,19,1,360,120],
    [1,6,1,90,120],[1,7,3,150,60],[1,8,0,210,120],
    [0,0,0,2*day,120],[0,1,3,2*day+60,180],[0,2,1,3*day,60],[1,0,1,2*day,120],[1,1,3,4*day,90],
  ];
  for (const row of demo) await book(...row);

  const start = addMinutes(base, day);
  await c.query(
    "INSERT INTO reservations (user_id,establishment_id,slot_id,start_at,end_at,hours_billed,hourly_rate,amount,commission_rate,status,created_at)" +
    " VALUES ($1,$2,$3,$4,$5,2,40,80,10,'cancelled',$6)",
    [customers[0], estIds[0], slotIds[0][5], fmt(start), fmt(addMinutes(start, 120)), created]);
}
