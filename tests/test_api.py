"""Backend tests. Run from the project folder:  python -m unittest discover -s tests -v"""
import os
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

# Use a throw-away database and instance folder so the real data is never touched.
_tmp = tempfile.mkdtemp()
os.environ["PARKEASE_DB"] = str(Path(_tmp) / "test.db")
os.environ["PARKEASE_SECRET_KEY"] = "test-secret"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.pop("PAYMONGO_SECRET_KEY", None)           # tests run against the built-in mock gateway
os.environ.pop("PARKEASE_SMTP_HOST", None)            # ...and never send real e-mail
import app as parkease  # noqa: E402
import database as db  # noqa: E402
import mailer  # noqa: E402
import payments  # noqa: E402

_sent = []  # e-mails the app tried to send during a test
mailer.send_mail = lambda to, subject, text, reply_to=None, wait=False: _sent.append((to, subject, text, reply_to)) or False

H = {"X-Requested-With": "ParkEase"}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for suffix in ("", "-wal", "-shm"):
            Path(str(db.DB_PATH) + suffix).unlink(missing_ok=True)
        db.init_db(seed_demo=True)
        parkease.app.config["TESTING"] = True

    def client(self, email=None, password=None):
        c = parkease.app.test_client()
        if email:
            r = c.post("/api/login", json={"email": email, "password": password}, headers=H)
            self.assertEqual(r.status_code, 200, r.get_json())
        return c

    def user(self, email="maria@email.com"):
        return self.client(email, "user123")

    def owner(self):
        return self.client("citywalk@parkease.com", "owner123")

    def admin(self):
        return self.client("admin@parkease.com", "admin123")

    @staticmethod
    def window(days=5, start="09:00", end="11:30"):
        d = (db.now_local() + timedelta(days=days)).strftime("%Y-%m-%d")
        return {"date": d, "arrival": start, "departure": end}

    def checkout(self, c, slot, win):
        return c.post("/api/reservations/checkout", json={"slot_id": slot, **win}, headers=H)

    def book(self, c, slot, win):
        """Full happy path through the (mock) payment page. Returns the final redirect location."""
        r = self.checkout(c, slot, win)
        self.assertEqual(r.status_code, 201, r.get_json())
        url = r.get_json()["url"]
        self.assertTrue(url.startswith("/pay/mock/"), url)
        token = url.rsplit("/", 1)[1]
        self.assertEqual(c.get(url).status_code, 200)
        back = c.post(url, data={"result": "pay"})
        self.assertIn(f"/payment/return?c={token}", back.headers["Location"])
        return c.get(back.headers["Location"]).headers["Location"]

    def free_slot(self, c, est_id=1, **w):
        win = self.window(**w)
        q = "&".join(f"{k}={v}" for k, v in win.items())
        slots = c.get(f"/api/establishments/{est_id}/slots?{q}").get_json()["slots"]
        return next(s for s in slots if s["free"])["id"], win


class AuthTests(Base):
    def test_pages_require_login_and_role(self):
        c = parkease.app.test_client()
        self.assertEqual(c.get("/user.html").status_code, 302)
        self.assertEqual(c.get("/api/me").status_code, 401)
        u = self.user()
        self.assertEqual(u.get("/user.html").status_code, 200)
        self.assertIn("/user.html", u.get("/admin.html").headers["Location"])
        self.assertEqual(u.get("/api/admin/users").status_code, 403)
        self.assertEqual(u.get("/api/establishment/overview").status_code, 403)

    def test_source_files_are_not_served(self):
        c = parkease.app.test_client()
        for path in ("/app.py", "/database.py", "/instance/test.db", "/pages/index.html"):
            self.assertNotEqual(c.get(path).status_code, 200, path)

    def test_login_failures(self):
        c = parkease.app.test_client()
        r = c.post("/api/login", json={"email": "maria@email.com", "password": "nope"}, headers=H)
        self.assertEqual(r.status_code, 401)
        r = c.post("/api/login", json={"email": "pedro@email.com", "password": "user123"}, headers=H)
        self.assertEqual(r.status_code, 403)  # seeded as Inactive

    def test_csrf_header_required(self):
        c = parkease.app.test_client()
        r = c.post("/api/login", json={"email": "maria@email.com", "password": "user123"})
        self.assertEqual(r.status_code, 403)

    def test_login_throttle(self):
        c = parkease.app.test_client()
        codes = [c.post("/api/login", json={"email": "ana@email.com", "password": "bad"}, headers=H).status_code
                 for _ in range(6)]
        self.assertEqual(codes[:5], [401] * 5)
        self.assertEqual(codes[5], 429)
        parkease._failed_logins.clear()

    def test_register_and_login(self):
        c = parkease.app.test_client()
        body = {"first_name": "New", "last_name": "Person", "email": "New@Person.com",
                "contact_number": "09170000000", "password": "longenough1"}
        self.assertEqual(c.post("/api/register", json=body, headers=H).status_code, 201)
        self.assertEqual(c.post("/api/register", json=body, headers=H).status_code, 409)  # duplicate
        self.assertEqual(c.post("/api/register", json={**body, "email": "x@y.com", "password": "short"},
                                headers=H).status_code, 400)
        r = c.post("/api/login", json={"email": "new@person.com", "password": "longenough1"}, headers=H)
        self.assertEqual(r.get_json()["redirect"], "/user.html")

    def test_logout(self):
        c = self.user()
        c.post("/api/logout", headers=H)
        self.assertEqual(c.get("/api/me").status_code, 401)


class ReservationTests(Base):
    def test_quote_rounds_up_partial_hours(self):
        c = self.user()
        slot, win = self.free_slot(c, start="09:00", end="11:30")
        q = c.post("/api/reservations/quote", json={"slot_id": slot, **win}, headers=H).get_json()
        self.assertEqual((q["minutes"], q["hours_billed"], q["amount"]), (150, 3, 120.0))  # 3h x P40

    def test_double_booking_is_blocked_and_overlap_detected(self):
        c = self.user()
        slot, win = self.free_slot(c, days=9, start="10:00", end="12:00")
        self.assertIn("payment=success", self.book(c, slot, win))
        other = self.user("juan@email.com")
        for s, e in [("10:00", "12:00"), ("11:00", "13:00"), ("09:00", "10:30"), ("10:30", "11:00")]:
            r = self.checkout(other, slot, self.window(9, s, e))
            self.assertEqual(r.status_code, 409, (s, e))
        # back-to-back is fine
        r = self.checkout(other, slot, self.window(9, "12:00", "13:00"))
        self.assertEqual(r.status_code, 201, r.get_json())

    def test_validation(self):
        c = self.user()
        slot, win = self.free_slot(c, days=11)
        bad = [
            {**win, "departure": win["arrival"]},                      # zero length
            {**win, "arrival": "12:00", "departure": "11:00"},         # reversed
            {**win, "arrival": "10:00", "departure": "10:10"},         # under the minimum
            {**self.window(-2)},                                       # in the past
            {**self.window(200)},                                      # too far ahead
            {**win, "date": "not-a-date"},
        ]
        for extra in bad:
            r = self.checkout(c, slot, {**win, **extra})
            self.assertEqual(r.status_code, 400, extra)
        self.assertEqual(self.checkout(c, 99999, win).status_code, 404)
        self.assertEqual(self.checkout(c, "abc", win).status_code, 400)

    def test_cannot_book_maintenance_slot(self):
        o, u = self.owner(), self.user()
        slot, win = self.free_slot(u, days=13)
        o.patch(f"/api/establishment/slots/{slot}", json={"is_active": False}, headers=H)
        self.assertEqual(self.checkout(u, slot, win).status_code, 409)
        o.patch(f"/api/establishment/slots/{slot}", json={"is_active": True}, headers=H)

    def test_my_reservations_only_shows_own(self):
        c = self.user("ana@email.com")
        mine = c.get("/api/reservations/mine?limit=50").get_json()
        self.assertTrue(mine)
        other = self.user("juan@email.com").get("/api/reservations/mine?limit=50").get_json()
        self.assertFalse({r["id"] for r in mine} & {r["id"] for r in other})


class EstablishmentTests(Base):
    def test_overview_adds_up(self):
        d = self.owner().get("/api/establishment/overview").get_json()
        self.assertEqual(d["incoming"] + d["completed"], d["reservations_total"])
        self.assertEqual(d["slots_available"] + d["slots_reserved"] + d["slots_occupied"], 20)
        self.assertGreater(d["slots_occupied"], 0)
        self.assertGreater(d["revenue"], 0)

    def test_new_booking_changes_overview(self):
        o, u = self.owner(), self.user()
        before = o.get("/api/establishment/overview").get_json()
        slot, win = self.free_slot(u, days=15, start="08:00", end="09:00")
        self.book(u, slot, win)
        after = o.get("/api/establishment/overview").get_json()
        self.assertEqual(after["reservations_total"], before["reservations_total"] + 1)
        self.assertEqual(round(after["revenue"] - before["revenue"], 2), 40.0)

    def test_slot_management(self):
        o = self.owner()
        self.assertEqual(o.post("/api/establishment/slots", json={"code": "z-99"}, headers=H).status_code, 201)
        self.assertEqual(o.post("/api/establishment/slots", json={"code": "Z-99"}, headers=H).status_code, 409)
        self.assertEqual(o.post("/api/establishment/slots", json={"code": "<b>"}, headers=H).status_code, 400)
        slots = o.get("/api/establishment/slots").get_json()["slots"]
        new = next(s for s in slots if s["code"] == "Z-99")
        self.assertEqual(o.delete(f"/api/establishment/slots/{new['id']}", headers=H).status_code, 200)
        booked = next(s for s in slots if s["state"] == "occupied")
        self.assertEqual(o.delete(f"/api/establishment/slots/{booked['id']}", headers=H).status_code, 409)

    def test_cannot_touch_another_establishments_slot(self):
        sm = self.client("smtarlac@parkease.com", "owner123")
        city_slot = self.owner().get("/api/establishment/slots").get_json()["slots"][0]["id"]
        self.assertEqual(sm.patch(f"/api/establishment/slots/{city_slot}", json={"is_active": False},
                                  headers=H).status_code, 404)
        self.assertEqual(sm.delete(f"/api/establishment/slots/{city_slot}", headers=H).status_code, 404)


class AdminTests(Base):
    def test_dashboard_totals(self):
        d = self.admin().get("/api/admin/dashboard").get_json()
        self.assertEqual(d["total_establishments"], 2)
        expected = round(sum(e["commission"] for e in d["establishments"]), 2)
        self.assertEqual(d["total_commission"], expected)
        self.assertGreater(d["total_commission"], 0)

    def test_cancelled_bookings_excluded_from_money(self):
        d = self.admin().get("/api/admin/dashboard").get_json()
        city = next(e for e in d["establishments"] if e["name"] == "CityWalk Tarlac")
        conn = db.get_connection()
        confirmed = conn.execute("SELECT COUNT(*) FROM reservations WHERE establishment_id=1 AND status='confirmed'").fetchone()[0]
        conn.close()
        self.assertEqual(city["reservations"], confirmed)

    def test_deactivating_user_blocks_access(self):
        a = self.admin()
        uid = next(u["id"] for u in a.get("/api/admin/users").get_json() if u["email"] == "ana@email.com")
        ana = self.user("ana@email.com")
        self.assertEqual(a.patch(f"/api/admin/users/{uid}", json={"status": "Inactive"}, headers=H).status_code, 200)
        self.assertEqual(ana.get("/api/me").status_code, 401)  # live session is cut off
        self.assertEqual(parkease.app.test_client().post(
            "/api/login", json={"email": "ana@email.com", "password": "user123"}, headers=H).status_code, 403)
        a.patch(f"/api/admin/users/{uid}", json={"status": "Active"}, headers=H)
        self.assertEqual(a.patch(f"/api/admin/users/{uid}", json={"status": "bogus"}, headers=H).status_code, 400)

    def test_inactive_establishment_hidden_from_customers(self):
        a, u = self.admin(), self.user()
        a.patch("/api/admin/establishments/2", json={"status": "Inactive"}, headers=H)
        names = [e["name"] for e in u.get("/api/establishments").get_json()]
        self.assertNotIn("SM City Tarlac", names)
        a.patch("/api/admin/establishments/2", json={"status": "Active"}, headers=H)
        self.assertIn("SM City Tarlac", [e["name"] for e in u.get("/api/establishments").get_json()])

    def test_reports_and_csv(self):
        a = self.admin()
        d = a.get("/api/admin/reports?months=12").get_json()
        self.assertTrue(d["months"])
        r = a.get("/api/admin/reports.csv")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.mimetype == "text/csv" and b"RES-" in r.data)
        self.assertEqual(self.user().get("/api/admin/reports.csv").status_code, 403)

    def test_csv_formula_injection_neutralised(self):
        self.assertEqual(parkease.csv_safe("=HYPERLINK(1)"), "'=HYPERLINK(1)")
        self.assertEqual(parkease.csv_safe("Juan"), "Juan")


def _count(sql, *args):
    conn = db.get_connection()
    try:
        return conn.execute(sql, args).fetchone()[0]
    finally:
        conn.close()


class PaymentTests(Base):
    def test_no_booking_until_paid(self):
        c = self.user()
        slot, win = self.free_slot(c, days=20)
        before = _count("SELECT COUNT(*) FROM reservations")
        url = self.checkout(c, slot, win).get_json()["url"]
        token = url.rsplit("/", 1)[1]
        # coming back without paying (e.g. forged return URL) must not create a booking
        r = c.get(f"/payment/return?c={token}")
        self.assertIn("payment=pending", r.headers["Location"])
        self.assertEqual(_count("SELECT COUNT(*) FROM reservations"), before)

    def test_unpaid_checkout_holds_slot_then_cancel_releases_it(self):
        a, b = self.user(), self.user("juan@email.com")
        slot, win = self.free_slot(a, days=21)
        token = self.checkout(a, slot, win).get_json()["url"].rsplit("/", 1)[1]
        self.assertEqual(self.checkout(b, slot, win).status_code, 409)       # held for the first customer
        self.assertIn("payment=cancelled", a.get(f"/payment/return?c={token}&cancelled=1").headers["Location"])
        self.assertEqual(self.checkout(b, slot, win).status_code, 201)       # released

    def test_cannot_use_someone_elses_checkout(self):
        a, b = self.user(), self.user("juan@email.com")
        slot, win = self.free_slot(a, days=22)
        url = self.checkout(a, slot, win).get_json()["url"]
        self.assertEqual(b.post(url, data={"result": "pay"}).status_code, 302)   # bounced home, nothing paid
        token = url.rsplit("/", 1)[1]
        self.assertEqual(_count("SELECT mock_paid FROM checkouts WHERE token = ?", token), 0)

    def test_return_is_idempotent(self):
        c = self.user()
        slot, win = self.free_slot(c, days=23)
        before = _count("SELECT COUNT(*) FROM reservations")
        self.assertIn("payment=success", self.book(c, slot, win))
        token = _count("SELECT token FROM checkouts ORDER BY id DESC LIMIT 1")
        # reloading / re-opening the return link (or a webhook arriving too) must not book twice
        self.assertIn("payment=success", c.get(f"/payment/return?c={token}").headers["Location"])
        self.assertIn("payment=success", c.get(f"/payment/return?c={token}").headers["Location"])
        self.assertEqual(_count("SELECT COUNT(*) FROM reservations"), before + 1)

    def test_paid_but_slot_taken_is_refunded(self):
        a, b = self.user(), self.user("juan@email.com")
        slot, win = self.free_slot(a, days=25)
        ta = self.checkout(a, slot, win).get_json()["url"].rsplit("/", 1)[1]
        # simulate the hold having expired and someone else booking it, then the first customer paying
        conn = db.get_connection()
        conn.execute("UPDATE checkouts SET created_at = '2000-01-01 00:00' WHERE token = ?", (ta,))
        conn.commit(); conn.close()
        self.assertIn("payment=success", self.book(b, slot, win))
        a.post(f"/pay/mock/{ta}", data={"result": "pay"})
        loc = a.get(f"/payment/return?c={ta}").headers["Location"]
        self.assertIn("payment=failed", loc)
        self.assertEqual(_count("SELECT COUNT(*) FROM reservations WHERE slot_id = ? AND start_at = ?",
                                slot, f"{win['date']} {win['arrival']}"), 1)

    def test_real_gateway_mode_never_shows_mock_page_and_verifies_with_gateway(self):
        c = self.user()
        slot, win = self.free_slot(c, days=26)
        calls = {}
        orig = (payments.secret_key, payments.create_checkout, payments.get_checkout)
        payments.secret_key = lambda: "sk_test_x"
        payments.create_checkout = lambda **kw: calls.update(kw) or {"id": "cs_123", "url": "https://pay.example/cs_123"}
        payments.get_checkout = lambda sid: {"paid": False, "payment_id": None, "method": ""}
        try:
            r = self.checkout(c, slot, win)
            self.assertEqual(r.get_json()["url"], "https://pay.example/cs_123")
            self.assertEqual(calls["amount"], 120.0)
            token = calls["success_url"].split("c=")[1]
            self.assertEqual(c.get(f"/pay/mock/{token}").status_code, 302)       # mock page disabled
            before = _count("SELECT COUNT(*) FROM reservations")
            c.get(f"/payment/return?c={token}")                                  # gateway says unpaid
            self.assertEqual(_count("SELECT COUNT(*) FROM reservations"), before)
            payments.get_checkout = lambda sid: {"paid": True, "payment_id": "pay_999", "method": "gcash"}
            self.assertIn("payment=success", c.get(f"/payment/return?c={token}").headers["Location"])
            self.assertEqual(_count("SELECT payment_ref FROM reservations ORDER BY id DESC LIMIT 1"), "pay_999")
        finally:
            payments.secret_key, payments.create_checkout, payments.get_checkout = orig

    def test_webhook_signature(self):
        import hashlib, hmac, json, time
        c = parkease.app.test_client()
        self.assertEqual(c.post("/webhooks/paymongo", data=b"{}").status_code, 404)  # not configured
        os.environ["PAYMONGO_WEBHOOK_SECRET"] = "whsk_test"
        try:
            body = json.dumps({"data": {"attributes": {"type": "other"}}}).encode()
            self.assertEqual(c.post("/webhooks/paymongo", data=body, headers={"Paymongo-Signature": "t=1,te=bad"}).status_code, 400)
            ts = str(int(time.time()))
            sig = hmac.new(b"whsk_test", f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
            r = c.post("/webhooks/paymongo", data=body, headers={"Paymongo-Signature": f"t={ts},te={sig},li="})
            self.assertEqual(r.status_code, 200)
        finally:
            del os.environ["PAYMONGO_WEBHOOK_SECRET"]


class CancelTests(Base):
    def test_cancel_with_notice_refunds_and_frees_slot(self):
        c, o = self.user(), self.owner()
        slot, win = self.free_slot(c, days=30)
        self.book(c, slot, win)
        res = next(r for r in c.get("/api/reservations/mine?limit=100&sort=start").get_json()
                   if r["status"] == "incoming" and r["start_at"].startswith(win["date"]) and r["can_cancel"])
        self.assertTrue(res["refundable"])
        r = c.post(f"/api/reservations/{res['id']}/cancel", headers=H)
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()["payment_status"], "refunded")
        mine = {x["id"]: x for x in c.get("/api/reservations/mine?limit=100").get_json()}
        self.assertEqual(mine[res["id"]]["status"], "cancelled")
        self.assertEqual(c.post(f"/api/reservations/{res['id']}/cancel", headers=H).status_code, 409)  # twice
        self.assertEqual(self.checkout(self.user("juan@email.com"), slot, win).status_code, 201)       # slot is free again
        # both sides were told
        self.assertIn("Booking cancelled", [n["title"] for n in c.get("/api/notifications").get_json()["items"]])
        self.assertIn("Reservation cancelled", [n["title"] for n in o.get("/api/notifications").get_json()["items"]])

    def test_cancel_removes_booking_from_revenue(self):
        c, o = self.user(), self.owner()
        slot, win = self.free_slot(c, days=31, start="13:00", end="14:00")
        self.book(c, slot, win)
        before = o.get("/api/establishment/overview").get_json()
        rid = next(r["id"] for r in c.get("/api/reservations/mine?limit=100").get_json() if r["can_cancel"] and r["start_at"].startswith(win["date"]))
        c.post(f"/api/reservations/{rid}/cancel", headers=H)
        after = o.get("/api/establishment/overview").get_json()
        self.assertEqual(after["reservations_total"], before["reservations_total"] - 1)
        self.assertEqual(round(before["revenue"] - after["revenue"], 2), 40.0)

    def test_late_cancel_is_allowed_but_not_refunded(self):
        c = self.user()
        soon = (db.now_local() + timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M")
        end = (db.now_local() + timedelta(minutes=120)).strftime("%Y-%m-%d %H:%M")
        conn = db.get_connection()
        uid = conn.execute("SELECT id FROM users WHERE email = 'maria@email.com'").fetchone()[0]
        rid = conn.execute("INSERT INTO reservations (user_id, establishment_id, slot_id, start_at, end_at, hours_billed,"
                           " hourly_rate, amount, commission_rate, created_at) VALUES (?,1,20,?,?,2,40,80,10,?)",
                           (uid, soon, end, soon)).lastrowid
        conn.commit(); conn.close()
        r = c.post(f"/api/reservations/{rid}/cancel", headers=H)
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()["payment_status"], "no_refund")

    def test_cannot_cancel_started_finished_or_foreign_bookings(self):
        c = self.user("juan@email.com")
        mine = c.get("/api/reservations/mine?limit=100").get_json()
        for state in ("ongoing", "completed"):
            rid = next(r["id"] for r in mine if r["status"] == state)
            self.assertEqual(c.post(f"/api/reservations/{rid}/cancel", headers=H).status_code, 409, state)
        someone_elses = next(r["id"] for r in self.user("maria@email.com").get("/api/reservations/mine?limit=100").get_json()
                             if r["can_cancel"])
        self.assertEqual(c.post(f"/api/reservations/{someone_elses}/cancel", headers=H).status_code, 404)
        self.assertEqual(self.owner().post(f"/api/reservations/{someone_elses}/cancel", headers=H).status_code, 403)

    def test_failed_refund_keeps_booking(self):
        c = self.user()
        slot, win = self.free_slot(c, days=33)
        self.book(c, slot, win)
        rid = next(r["id"] for r in c.get("/api/reservations/mine?limit=100").get_json() if r["can_cancel"] and r["start_at"].startswith(win["date"]))
        conn = db.get_connection(); conn.execute("UPDATE reservations SET payment_ref = 'pay_1' WHERE id = ?", (rid,)); conn.commit(); conn.close()
        orig = (payments.secret_key, payments.refund)
        payments.secret_key = lambda: "sk_test_x"
        def boom(*a, **k): raise payments.PaymentError("gateway down")
        payments.refund = boom
        try:
            self.assertEqual(c.post(f"/api/reservations/{rid}/cancel", headers=H).status_code, 502)
            self.assertEqual(_count("SELECT status FROM reservations WHERE id = ?", rid), "confirmed")
            payments.refund = lambda *a, **k: "pending"
            r = c.post(f"/api/reservations/{rid}/cancel", headers=H)
            self.assertEqual(r.get_json()["payment_status"], "refund_pending")
        finally:
            payments.secret_key, payments.refund = orig


class PasswordResetTests(Base):
    def setUp(self):
        _sent.clear(); parkease._reset_requests.clear(); parkease._reset_attempts.clear()

    @staticmethod
    def _restore_password(email):  # other tests log in with the demo password
        from werkzeug.security import generate_password_hash
        conn = db.get_connection()
        conn.execute("UPDATE users SET password_hash = ? WHERE email = ?", (generate_password_hash("user123"), email))
        conn.commit(); conn.close()

    def token(self, email):
        _sent.clear()
        r = parkease.app.test_client().post("/api/password/forgot", json={"email": email}, headers=H)
        self.assertEqual(r.status_code, 200)
        mail = next(m for m in _sent if m[0] == email and "Reset" in m[1])
        return mail[2].split("token=")[1].split()[0]

    def test_full_reset_flow(self):
        tok = self.token("ana@email.com")
        c = parkease.app.test_client()
        self.assertEqual(c.get("/reset.html").status_code, 200)               # public page
        self.assertEqual(c.post("/api/password/reset", json={"token": tok, "password": "short"}, headers=H).status_code, 400)
        self.assertEqual(c.post("/api/password/reset", json={"token": tok, "password": "brandnewpass1"}, headers=H).status_code, 200)
        self.assertEqual(c.post("/api/login", json={"email": "ana@email.com", "password": "brandnewpass1"}, headers=H).status_code, 200)
        self.assertEqual(c.post("/api/login", json={"email": "ana@email.com", "password": "user123"}, headers=H).status_code, 401)
        # the link works once only
        self.assertEqual(c.post("/api/password/reset", json={"token": tok, "password": "anotherpass1"}, headers=H).status_code, 400)
        self.assertTrue(any("changed" in m[1] for m in _sent))                # confirmation e-mail
        self._restore_password("ana@email.com")

    def test_unknown_email_gets_same_answer_and_no_mail(self):
        c = parkease.app.test_client()
        known = c.post("/api/password/forgot", json={"email": "maria@email.com"}, headers=H)
        unknown = c.post("/api/password/forgot", json={"email": "nobody@nowhere.com"}, headers=H)
        self.assertEqual((known.status_code, known.get_json()), (unknown.status_code, unknown.get_json()))
        self.assertEqual([m[0] for m in _sent], ["maria@email.com"])
        self.assertEqual(c.post("/api/password/forgot", json={"email": "bad"}, headers=H).status_code, 400)

    def test_token_is_stored_hashed_and_expires(self):
        tok = self.token("maria@email.com")
        self.assertEqual(_count("SELECT COUNT(*) FROM password_resets WHERE token_hash = ?", tok), 0)
        conn = db.get_connection(); conn.execute("UPDATE password_resets SET expires_at = '2000-01-01 00:00'"); conn.commit(); conn.close()
        r = parkease.app.test_client().post("/api/password/reset", json={"token": tok, "password": "longenough1"}, headers=H)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(parkease.app.test_client().post("/api/password/reset", json={"token": "garbage", "password": "longenough1"}, headers=H).status_code, 400)

    def test_new_request_invalidates_old_link_and_inactive_users_get_nothing(self):
        old = self.token("juan@email.com")
        parkease._reset_requests.clear()
        new = self.token("juan@email.com")
        c = parkease.app.test_client()
        self.assertEqual(c.post("/api/password/reset", json={"token": old, "password": "longenough1"}, headers=H).status_code, 400)
        self.assertEqual(c.post("/api/password/reset", json={"token": new, "password": "user12345"}, headers=H).status_code, 200)
        self._restore_password("juan@email.com")
        _sent.clear()
        c.post("/api/password/forgot", json={"email": "pedro@email.com"}, headers=H)   # seeded Inactive
        self.assertEqual(_sent, [])

    def test_forgot_is_rate_limited(self):
        c = parkease.app.test_client()
        codes = [c.post("/api/password/forgot", json={"email": "maria@email.com"}, headers=H).status_code for _ in range(5)]
        self.assertIn(429, codes)


class NotificationContactMapTests(Base):
    def test_notifications_are_private_and_markable(self):
        c = self.user("maria@email.com")
        conn = db.get_connection()
        uid = conn.execute("SELECT id FROM users WHERE email='maria@email.com'").fetchone()[0]
        conn.execute("INSERT INTO notifications (user_id, title, body, created_at) VALUES (?, 'Hello', 'x', '2026-01-01 00:00')", (uid,))
        conn.commit(); conn.close()
        d = c.get("/api/notifications").get_json()
        self.assertGreaterEqual(d["unread"], 1)
        self.assertEqual(c.post("/api/notifications/read", json={"id": d["items"][0]["id"]}, headers=H).status_code, 200)
        other = self.user("juan@email.com").get("/api/notifications").get_json()
        self.assertNotIn(d["items"][0]["id"], [n["id"] for n in other["items"]])
        c.post("/api/notifications/read", json={}, headers=H)
        self.assertEqual(c.get("/api/notifications").get_json()["unread"], 0)
        self.assertEqual(parkease.app.test_client().get("/api/notifications").status_code, 401)

    def test_contact_form(self):
        _sent.clear(); parkease._contact_sends.clear()
        c = self.user("ana@email.com")
        self.assertEqual(c.post("/api/contact", json={"subject": "", "message": "long enough message"}, headers=H).status_code, 400)
        self.assertEqual(c.post("/api/contact", json={"subject": "Hi", "message": "short"}, headers=H).status_code, 400)
        r = c.post("/api/contact", json={"subject": "Refund question\r\nBcc: evil@x.com", "message": "Where is my refund?"}, headers=H)
        self.assertEqual(r.status_code, 201, r.get_json())
        to, subject, body, reply_to = _sent[-1]
        self.assertEqual((to, reply_to), ("admin@parkease.com", "ana@email.com"))
        self.assertIn("Where is my refund?", body)
        self.assertTrue(any(n["title"].startswith("Message from") for n in self.admin().get("/api/notifications").get_json()["items"]))
        self.assertEqual(parkease.app.test_client().post("/api/contact", json={"subject": "a", "message": "b" * 20}, headers=H).status_code, 401)
        # header injection is neutralised by the mailer itself
        self.assertNotIn("\n", mailer.build_message("a@b.com", "x\r\nBcc: e@x.com", "t")["Subject"])

    def test_contact_rate_limit(self):
        parkease._contact_sends.clear()
        c = self.user("ana@email.com")
        codes = [c.post("/api/contact", json={"subject": "s", "message": "a long enough message"}, headers=H).status_code for _ in range(6)]
        self.assertEqual(codes[-1], 429)
        parkease._contact_sends.clear()

    def test_parking_locations_and_owner_pin(self):
        c, o = self.user(), self.owner()
        places = c.get("/api/parking-locations").get_json()
        self.assertEqual({p["name"] for p in places}, {"CityWalk Tarlac", "SM City Tarlac"})
        self.assertTrue(all(p["latitude"] and p["longitude"] for p in places))
        self.assertEqual(o.get("/api/parking-locations").status_code, 403)
        ok = o.put("/api/establishment/location", json={"latitude": 15.5, "longitude": 120.6, "address": "New Road"}, headers=H)
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(next(p for p in c.get("/api/parking-locations").get_json() if p["name"] == "CityWalk Tarlac")["latitude"], 15.5)
        for bad in ({"latitude": 91, "longitude": 0}, {"latitude": "x", "longitude": 0}, {"latitude": 1, "longitude": 181},
                    {"latitude": float("nan"), "longitude": 0}):
            self.assertEqual(o.put("/api/establishment/location", json={"address": "a", **bad}, headers=H).status_code, 400, bad)
        self.assertEqual(c.put("/api/establishment/location", json={"latitude": 1, "longitude": 1}, headers=H).status_code, 403)


class FrontEndTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def test_login_page_has_no_role_shortcuts(self):
        page = (self.ROOT / "pages/index.html").read_text()
        js = (self.ROOT / "public/js/login.js").read_text()
        for word in ("demo-buttons", "data-demo", "ESTABLISHMENT</button>"):
            self.assertNotIn(word, page)
        for word in ("DEMO", "user123", "owner123", "admin123"):
            self.assertNotIn(word, js)

    def test_every_user_and_establishment_header_has_working_links(self):
        for name in ("user", "user2", "user3", "user4", "establishment", "establishment2", "establishment3"):
            page = (self.ROOT / f"pages/{name}.html").read_text()
            for ident in ("about-link", "contact-link", "notifications-link"):
                self.assertIn(f'id="{ident}"', page, (name, ident))
        for name in ("admin", "admin2", "admin3", "admin4"):
            self.assertIn('id="notifications-link"', (self.ROOT / f"pages/{name}.html").read_text(), name)

    def test_dark_mode_styles_header_and_side_panel(self):
        css = (self.ROOT / "public/Styles/dark.css").read_text()
        self.assertIn("html.dark-mode .header", css)
        self.assertIn("html.dark-mode .side-panel", css)

    def test_new_pages_served_to_customers_only(self):
        c = parkease.app.test_client()
        for page in ("user3.html", "user4.html"):
            self.assertEqual(c.get("/" + page).status_code, 302)
        u = c.post("/api/login", json={"email": "maria@email.com", "password": "user123"}, headers=H)
        for page in ("user3.html", "user4.html"):
            self.assertEqual(c.get("/" + page).status_code, 200)
        c.post("/api/logout", headers=H)
        c.post("/api/login", json={"email": "citywalk@parkease.com", "password": "owner123"}, headers=H)
        self.assertEqual(c.get("/user4.html").status_code, 302)

    def test_reset_page_sends_no_referrer(self):
        self.assertIn('name="referrer" content="no-referrer"', (self.ROOT / "pages/reset.html").read_text())


if __name__ == "__main__":
    unittest.main()
