/* My Bookings: every booking with its status, payment/refund info, directions and a Cancel button */
(function () {
    "use strict";
    const box = document.getElementById("booking-list");
    const PAY_TEXT = {
        paid: "Paid", refunded: "Refunded", refund_pending: "Refund processing", no_refund: "Cancelled - no refund",
    };

    const mapsLink = (r) => `https://www.google.com/maps/dir/?api=1&destination=${r.latitude},${r.longitude}`;

    async function cancel(r, button) {
        const refundText = r.refundable
            ? "You'll be refunded in full."
            : `It's less than ${r.refund_hours} hour(s) before arrival, so this booking is NOT refundable.`;
        if (!window.confirm(`Cancel ${r.location}, slot ${r.slot} on ${PE.fmtDate(r.start_at)} at ${PE.fmtTime(r.start_at)}?\n\n${refundText}`)) return;
        button.disabled = true;
        try {
            const res = await PE.api(`/api/reservations/${r.id}/cancel`, { method: "POST" });
            PE.toast(`Booking cancelled. ${res.message}`, "success");
            await load();
        } catch (err) {
            PE.toast(err.message, "error");
            button.disabled = false;
        }
    }

    function card(r) {
        const actions = [];
        if (r.can_cancel) {
            const btn = PE.el("button", { type: "button", class: "cancel-btn", text: "Cancel booking" });
            btn.addEventListener("click", () => cancel(r, btn));
            actions.push(btn);
        }
        if (r.latitude !== null && r.status !== "cancelled" && r.status !== "completed") {
            actions.push(PE.el("a", { href: mapsLink(r), target: "_blank", rel: "noopener noreferrer" }, [
                PE.el("i", { class: "fa-solid fa-diamond-turn-right" }), " Directions"]));
        }
        return PE.el("div", { class: "booking-card" }, [
            PE.el("div", { class: "booking-main" }, [
                PE.el("span", { class: "booking-code", text: r.code }),
                PE.el("h3", { text: `${r.location} · Slot ${r.slot}` }),
                PE.el("p", { text: `${PE.fmtDate(r.start_at)}, ${PE.fmtTime(r.start_at)} - ${PE.fmtTime(r.end_at)} (${PE.fmtDuration(PE.minutesBetween(r.start_at, r.end_at))})` }),
                PE.el("div", { class: "booking-actions" }, actions),
            ]),
            PE.el("div", { class: "booking-side" }, [
                PE.statusChip(r.status),
                PE.el("span", { class: "booking-amount", text: PE.peso(r.amount) }),
                PE.el("span", { class: "booking-pay", text: PAY_TEXT[r.payment_status] || r.payment_status }),
            ]),
        ]);
    }

    async function load() {
        const list = await PE.api("/api/reservations/mine?limit=100&sort=start");
        if (!list.length) {
            box.replaceChildren(PE.el("p", { class: "empty-note", text: "You have no bookings yet. Reserve a slot from New Reservation." }));
            return;
        }
        box.replaceChildren(...list.map(card));
    }

    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    if (payment === "success") PE.toast("Payment received - your booking is confirmed!", "success");
    if (payment === "pending") PE.toast("We're still confirming your payment. Refresh in a moment; the booking will appear here once it's confirmed.");
    if (payment) window.history.replaceState(null, "", window.location.pathname);

    PE.poll(load, 30000);
})();
