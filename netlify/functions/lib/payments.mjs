// PayMongo client (GCash, Maya, cards). Without PAYMONGO_SECRET_KEY the app uses the fake test checkout.
const API = "https://api.paymongo.com/v1";

export class PaymentError extends Error {}

const secretKey = () => (process.env.PAYMONGO_SECRET_KEY || "").trim();
export const mode = () => (secretKey() ? "paymongo" : "mock");
const methods = () => (process.env.PAYMONGO_METHODS || "gcash,paymaya,card").split(",").map((m) => m.trim()).filter(Boolean);
const centavos = (amount) => Math.round(Number(amount) * 100);

async function request(method, path, payload) {
  const auth = Buffer.from(`${secretKey()}:`).toString("base64");
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new PaymentError("Could not reach the payment gateway. Please try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data.errors || []).map((e) => e.detail || "").join("; ");
    throw new PaymentError(`Payment gateway error (${res.status}). ${detail}`.trim());
  }
  return data;
}

export async function createCheckout({ amount, name, description, reference, successUrl, cancelUrl, customerName, customerEmail }) {
  const body = { data: { attributes: {
    billing: { name: customerName, email: customerEmail },
    send_email_receipt: true, show_description: true, show_line_items: true,
    description, reference_number: reference,
    line_items: [{ currency: "PHP", amount: centavos(amount), name, description, quantity: 1 }],
    payment_method_types: methods(), success_url: successUrl, cancel_url: cancelUrl,
  } } };
  const data = (await request("POST", "/checkout_sessions", body)).data || {};
  const url = data.attributes && data.attributes.checkout_url;
  if (!data.id || !url) throw new PaymentError("The payment gateway returned an unexpected response.");
  return { id: data.id, url };
}

export async function getCheckout(sessionId) {
  const attrs = ((await request("GET", `/checkout_sessions/${encodeURIComponent(sessionId)}`)).data || {}).attributes || {};
  for (const pay of attrs.payments || []) {
    const pa = pay.attributes || {};
    if (pa.status === "paid") {
      return { paid: true, paymentId: pay.id, method: attrs.payment_method_used || (pa.source || {}).type || "" };
    }
  }
  const intent = (attrs.payment_intent || {}).attributes || {};
  if (intent.status === "succeeded") return { paid: true, paymentId: null, method: attrs.payment_method_used || "" };
  return { paid: false, paymentId: null, method: "" };
}

export async function refund(paymentId, amount, reason = "requested_by_customer") {
  const body = { data: { attributes: { amount: centavos(amount), payment_id: paymentId, reason, notes: "ParkEase booking cancelled" } } };
  const status = (((await request("POST", "/refunds", body)).data || {}).attributes || {}).status || "pending";
  return status === "succeeded" ? "succeeded" : "pending";
}
