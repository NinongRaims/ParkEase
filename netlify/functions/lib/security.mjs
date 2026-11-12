// Password hashing (scrypt) and signed session cookies, using only Node's built-in crypto.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function checkPassword(hash, password) {
  const [kind, saltHex, keyHex] = String(hash || "").split("$");
  if (kind !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/* The signing secret: PARKEASE_SECRET_KEY if set, otherwise derived from the database URL (which already
   contains a secret password), so the site works out of the box. Set PARKEASE_SECRET_KEY to rotate it. */
function secret() {
  const base = process.env.PARKEASE_SECRET_KEY ||
    process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || "";
  if (!base) throw new Error("Set PARKEASE_SECRET_KEY (or connect a database) before using the site.");
  return crypto.createHash("sha256").update("parkease-session|" + base).digest();
}

const sign = (payload) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

export function makeSession(uid, days) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + days * 86400000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSession(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now() && Number.isInteger(data.uid) ? data : null;
  } catch { return null; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function verifyWebhook(rawBody, header, whSecret) {
  if (!header || !whSecret) return false;
  const parts = Object.fromEntries(header.split(",").filter((p) => p.includes("=")).map((p) => {
    const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)];
  }));
  const expected = crypto.createHmac("sha256", whSecret).update(`${parts.t || ""}.${rawBody}`).digest("hex");
  return [parts.te, parts.li].some((c) => c && c.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(c), Buffer.from(expected)));
}
