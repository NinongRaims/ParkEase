// Small shared helpers: errors, validation, local-time handling.
export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
export const TZ = process.env.PARKEASE_TZ || "Asia/Manila";

const pad = (n, w = 2) => String(n).padStart(w, "0");

/* Local wall-clock times are kept as Date objects whose UTC fields hold the *local* numbers
   ("fake UTC"), so adding/subtracting never trips over time zones or daylight saving. */
export function nowLocal() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return new Date(Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")));
}

export const fmt = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
export const nowStr = () => fmt(nowLocal());
export const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);

/** Parse "YYYY-MM-DD HH:MM" strictly (rejects Feb 30, 25:00 ...). Returns a Date or null. */
export function parseLocal(s) {
  if (typeof s !== "string" || !DT_RE.test(s)) return null;
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)));
  return fmt(d) === s ? d : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (d) => `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${d.getUTCFullYear()}`;
export function fmtClock(d) {
  const h = d.getUTCHours();
  return `${pad(h % 12 === 0 ? 12 : h % 12)}:${pad(d.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

export function cleanStr(value, field, maxLen, required = true) {
  if (value === null || value === undefined) value = "";
  if (typeof value !== "string") throw new ApiError(`${field} is invalid.`);
  value = value.trim();
  if (required && !value) throw new ApiError(`${field} is required.`);
  if (value.length > maxLen) throw new ApiError(`${field} must be at most ${maxLen} characters.`);
  return value;
}

export function asInt(value, field) {
  if (typeof value === "boolean" || value === null || value === undefined || String(value).trim() === "") {
    throw new ApiError(`${field} is invalid.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ApiError(`${field} is invalid.`);
  return n;
}

export const money = (v) => Math.round(Number(v || 0) * 100) / 100;
export const pesoText = (amount) =>
  "PHP " + Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Records one attempt; true when `key` has exceeded `limit` attempts in `windowSec` (per warm instance). */
export function hitRateLimit(bucket, key, limit, windowSec) {
  const now = Date.now() / 1000;
  const hits = (bucket.get(key) || []).filter((t) => now - t < windowSec);
  hits.push(now);
  bucket.set(key, hits);
  return hits.length > limit;
}
