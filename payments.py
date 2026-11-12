"""Payment gateway client: PayMongo (https://developers.paymongo.com), which accepts GCash, Maya and
credit/debit cards in the Philippines.

Settings (environment variables):

    PAYMONGO_SECRET_KEY      sk_test_...  (test mode)  or  sk_live_...  (real money)
    PAYMONGO_METHODS         payment methods to offer, default "gcash,paymaya,card"
    PAYMONGO_WEBHOOK_SECRET  whsk_...  (optional) enables POST /webhooks/paymongo

Without PAYMONGO_SECRET_KEY the app runs in TEST MODE: a local fake checkout page is used and no money
moves. That is meant for development only.

Flow: the customer is sent to a PayMongo-hosted Checkout page (so card / wallet details never touch this
server). When they come back we ask PayMongo whether the session was really paid before confirming the
booking - we never trust the redirect URL alone.
"""
import base64
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.request

API = "https://api.paymongo.com/v1"


class PaymentError(Exception):
    pass


def secret_key() -> str:
    return os.environ.get("PAYMONGO_SECRET_KEY", "").strip()


def mode() -> str:
    return "paymongo" if secret_key() else "mock"


def methods() -> list:
    raw = os.environ.get("PAYMONGO_METHODS", "gcash,paymaya,card")
    return [m.strip() for m in raw.split(",") if m.strip()]


def centavos(amount: float) -> int:
    return int(round(float(amount) * 100))


def _request(method: str, path: str, payload: dict | None = None) -> dict:
    token = base64.b64encode(f"{secret_key()}:".encode()).decode()
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Basic {token}", "Content-Type": "application/json",
                 "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            errs = json.loads(exc.read().decode()).get("errors") or []
            detail = "; ".join(e.get("detail", "") for e in errs)
        except Exception:  # noqa: BLE001 - best effort only
            pass
        raise PaymentError(f"Payment gateway error ({exc.code}). {detail}".strip()) from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise PaymentError("Could not reach the payment gateway. Please try again.") from exc


def create_checkout(*, amount: float, name: str, description: str, reference: str, success_url: str,
                    cancel_url: str, customer_name: str, customer_email: str) -> dict:
    """Create a hosted checkout session. Returns {"id", "url"}."""
    body = {"data": {"attributes": {
        "billing": {"name": customer_name, "email": customer_email},
        "send_email_receipt": True,
        "show_description": True,
        "show_line_items": True,
        "description": description,
        "reference_number": reference,
        "line_items": [{"currency": "PHP", "amount": centavos(amount), "name": name,
                        "description": description, "quantity": 1}],
        "payment_method_types": methods(),
        "success_url": success_url,
        "cancel_url": cancel_url,
    }}}
    data = _request("POST", "/checkout_sessions", body).get("data", {})
    url = data.get("attributes", {}).get("checkout_url")
    if not data.get("id") or not url:
        raise PaymentError("The payment gateway returned an unexpected response.")
    return {"id": data["id"], "url": url}


def get_checkout(session_id: str) -> dict:
    """Ask PayMongo whether a checkout session was paid. Returns {"paid", "payment_id", "method"}."""
    attrs = _request("GET", f"/checkout_sessions/{session_id}").get("data", {}).get("attributes", {})
    for pay in attrs.get("payments") or []:
        pa = pay.get("attributes", {})
        if pa.get("status") == "paid":
            method = attrs.get("payment_method_used") or (pa.get("source") or {}).get("type") or ""
            return {"paid": True, "payment_id": pay.get("id"), "method": method}
    intent = (attrs.get("payment_intent") or {}).get("attributes", {})
    if intent.get("status") == "succeeded":  # paid, but payment id not listed (should not normally happen)
        return {"paid": True, "payment_id": None, "method": attrs.get("payment_method_used") or ""}
    return {"paid": False, "payment_id": None, "method": ""}


def refund(payment_id: str, amount: float, reason: str = "requested_by_customer") -> str:
    """Refund a payment. Returns PayMongo's refund status ('succeeded' or 'pending')."""
    body = {"data": {"attributes": {"amount": centavos(amount), "payment_id": payment_id,
                                    "reason": reason, "notes": "ParkEase booking cancelled"}}}
    status = _request("POST", "/refunds", body).get("data", {}).get("attributes", {}).get("status", "pending")
    return "succeeded" if status == "succeeded" else "pending"


def verify_webhook(raw_body: bytes, header: str, secret: str) -> bool:
    """Check PayMongo's 'Paymongo-Signature' header: t=<ts>,te=<test sig>,li=<live sig>, where the
    signature is HMAC-SHA256 of '<ts>.<raw body>' with the webhook secret."""
    if not header or not secret:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    ts = parts.get("t", "")
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    candidates = [parts.get("te", ""), parts.get("li", "")]
    return any(c and hmac.compare_digest(expected, c) for c in candidates)
