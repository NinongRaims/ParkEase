import test from "node:test";
import assert from "node:assert/strict";
process.env.PARKEASE_SECRET_KEY = "test-secret";
const { parseLocal, fmt, fmtClock, fmtDay, asInt, cleanStr, hitRateLimit, ApiError, nowLocal } = await import("../netlify/functions/lib/util.mjs");
const sec = await import("../netlify/functions/lib/security.mjs");

test("parseLocal is strict", () => {
  assert.equal(fmt(parseLocal("2026-11-12 09:30")), "2026-11-12 09:30");
  assert.equal(parseLocal("2026-02-30 10:00"), null);
  assert.equal(parseLocal("2026-11-12 25:00"), null);
  assert.equal(parseLocal("garbage"), null);
});
test("12-hour clock + day formatting", () => {
  assert.equal(fmtClock(parseLocal("2026-11-12 00:05")), "12:05 AM");
  assert.equal(fmtClock(parseLocal("2026-11-12 13:00")), "01:00 PM");
  assert.equal(fmtDay(parseLocal("2026-11-02 08:00")), "Nov 02, 2026");
});
test("validation", () => {
  assert.equal(asInt("5", "x"), 5);
  assert.throws(() => asInt(true, "x"), ApiError);
  assert.throws(() => asInt("1.5", "x"), ApiError);
  assert.throws(() => cleanStr("", "Name", 5), ApiError);
  assert.equal(cleanStr("  hi ", "Name", 5), "hi");
});
test("rate limit", () => {
  const b = new Map();
  for (let i = 0; i < 3; i++) assert.equal(hitRateLimit(b, "k", 3, 60), false);
  assert.equal(hitRateLimit(b, "k", 3, 60), true);
});
test("nowLocal returns a valid minute-precision date", () => {
  assert.ok(parseLocal(fmt(nowLocal())));
});
test("password hash round trip", async () => {
  const h = await sec.hashPassword("hunter2hunter2");
  assert.equal(await sec.checkPassword(h, "hunter2hunter2"), true);
  assert.equal(await sec.checkPassword(h, "wrong"), false);
  assert.equal(await sec.checkPassword("junk", "x"), false);
});
test("session tokens are signed and expire", () => {
  const t = sec.makeSession(7, 1);
  assert.equal(sec.readSession(t).uid, 7);
  assert.equal(sec.readSession(t.slice(0, -2) + "xx"), null);
  assert.equal(sec.readSession(sec.makeSession(7, -1)), null);
  assert.equal(sec.readSession(""), null);
});
test("webhook signature", async () => {
  const crypto = await import("node:crypto");
  const body = '{"a":1}', ts = "123";
  const sig = crypto.createHmac("sha256", "whsec").update(`${ts}.${body}`).digest("hex");
  assert.equal(sec.verifyWebhook(body, `t=${ts},te=${sig},li=`, "whsec"), true);
  assert.equal(sec.verifyWebhook(body, `t=${ts},te=bad,li=`, "whsec"), false);
});
