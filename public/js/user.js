/* New Reservation page */
(function () {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const locationSel = $("location"), slotSel = $("slot"), dateIn = $("date");
    const arrivalIn = $("arrival"), departureIn = $("departure");
    const reserveBtn = $("reserve-button"), confirmBtn = $("confirm-button");

    let establishments = [];
    let quoted = false;
    let slotTimer;

    function selectedEstablishment() {
        return establishments.find((e) => String(e.id) === locationSel.value);
    }

    /* ----- summary panel ----- */
    function localDuration() {
        if (!arrivalIn.value || !departureIn.value) return null;
        const mins = PE.minutesBetween(arrivalIn.value, departureIn.value);
        return mins > 0 ? mins : null;
    }

    function resetQuote() {
        quoted = false;
        confirmBtn.disabled = true;
        $("summary-pay").textContent = PE.peso(0);
    }

    function updateSummary() {
        const est = selectedEstablishment();
        const slotOpt = slotSel.options[slotSel.selectedIndex];
        const mins = localDuration();
        $("summary-location").textContent = est ? est.name : "-";
        $("summary-slot").textContent = slotSel.value && slotOpt ? slotOpt.dataset.code : "-";
        $("summary-rate").textContent = est ? PE.peso(est.hourly_rate) + " / hour" : "-";
        $("summary-duration").textContent = mins ? PE.fmtHM(mins) : "0:00";
    }

    function onInputChanged() {
        resetQuote();
        updateSummary();
    }

    /* ----- slots for the chosen location / time window ----- */
    async function loadSlots() {
        const est = selectedEstablishment();
        const previous = slotSel.value;
        slotSel.replaceChildren(PE.el("option", { value: "", text: "Slot" }));
        slotSel.disabled = !est;
        if (!est) return updateSummary();

        const params = new URLSearchParams();
        if (dateIn.value && arrivalIn.value && departureIn.value) {
            params.set("date", dateIn.value);
            params.set("arrival", arrivalIn.value);
            params.set("departure", departureIn.value);
        }
        try {
            const data = await PE.api(`/api/establishments/${est.id}/slots?${params}`);
            if (selectedEstablishment() !== est) return; // user changed location meanwhile
            data.slots.forEach((s) => {
                slotSel.append(PE.el("option", {
                    value: s.id, "data-code": s.code, disabled: !s.free,
                    text: s.free ? s.code : `${s.code} (taken)`,
                }));
            });
            if ([...slotSel.options].some((o) => o.value === previous && !o.disabled)) slotSel.value = previous;
        } catch (err) {
            PE.toast(err.message, "error");
        }
        updateSummary();
    }

    function scheduleSlotLoad() {
        clearTimeout(slotTimer);
        slotTimer = setTimeout(loadSlots, 200);
    }

    /* ----- recent activity ----- */
    async function loadActivity() {
        const list = await PE.api("/api/reservations/mine?limit=6");
        const box = $("activity-list");
        if (!list.length) {
            box.replaceChildren(PE.el("div", { class: "activity-item" }, [PE.el("span", { text: "No reservations yet." })]));
            return;
        }
        box.replaceChildren(...list.map((r) => PE.el("div", { class: "activity-item" }, [
            PE.el("span", { text: `${r.location} · ${r.slot}` }),
            PE.el("span", { text: PE.fmtDate(r.start_at) }),
            PE.el("span", { text: PE.fmtDuration(PE.minutesBetween(r.start_at, r.end_at)) }),
        ])));
    }

    /* ----- actions ----- */
    function windowBody() {
        return { slot_id: Number(slotSel.value), date: dateIn.value, arrival: arrivalIn.value, departure: departureIn.value };
    }

    function validateForm() {
        if (!locationSel.value) return "Please choose a location.";
        if (!slotSel.value) return "Please choose a parking slot.";
        if (!dateIn.value || !arrivalIn.value || !departureIn.value) return "Please fill in the date, arrival and departure.";
        if (!localDuration()) return "Departure must be after arrival.";
        return null;
    }

    reserveBtn.addEventListener("click", async () => {
        const problem = validateForm();
        if (problem) return PE.toast(problem, "error");
        reserveBtn.disabled = true;
        try {
            const q = await PE.api("/api/reservations/quote", { method: "POST", body: windowBody() });
            $("summary-pay").textContent = PE.peso(q.amount);
            $("summary-duration").textContent = PE.fmtHM(q.minutes);
            quoted = true;
            confirmBtn.disabled = false;
            PE.toast("Slot is available. Review the summary and press Confirm.", "success");
        } catch (err) {
            resetQuote();
            PE.toast(err.message, "error");
            loadSlots();
        } finally {
            reserveBtn.disabled = false;
        }
    });

    // Pay Now: the slot is held and the customer goes to the payment page. The booking is only created
    // once the payment is confirmed (see My Bookings).
    confirmBtn.addEventListener("click", async () => {
        if (!quoted) return;
        confirmBtn.disabled = true;
        try {
            const res = await PE.api("/api/reservations/checkout", { method: "POST", body: windowBody() });
            PE.toast("Taking you to the secure payment page…");
            window.location.href = res.url;
        } catch (err) {
            PE.toast(err.message, "error");
            resetQuote();
            loadSlots();
        }
    });

    [locationSel].forEach((n) => n.addEventListener("change", () => { onInputChanged(); loadSlots(); }));
    [dateIn, arrivalIn, departureIn].forEach((n) => n.addEventListener("change", () => { onInputChanged(); scheduleSlotLoad(); }));
    slotSel.addEventListener("change", onInputChanged);

    /* ----- start ----- */
    async function loadEstablishmentRates() {
        establishments = await PE.api("/api/establishments");
        const keep = locationSel.value;
        locationSel.replaceChildren(PE.el("option", { value: "", text: "Location" }),
            ...establishments.map((e) => PE.el("option", { value: e.id, text: e.name })));
        locationSel.value = keep;
    }

    (async function init() {
        try {
            const me = await PE.me();
            $("welcome-name").textContent = `${me.last_name}, ${me.first_name}`.toUpperCase();
            const today = new Date();
            dateIn.min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
            await loadEstablishmentRates();
            const params = new URLSearchParams(window.location.search);
            const wanted = params.get("location");   // from "Reserve here" on the map page
            if (wanted && [...locationSel.options].some((o) => o.value === wanted)) {
                locationSel.value = wanted;
                await loadSlots();
            }
            if (params.get("payment") === "cancelled") PE.toast("Payment cancelled. No booking was made.");
            if (params.get("payment") === "failed") PE.toast("That booking could not be completed. If you were charged, you'll be refunded.", "error");
            if (params.has("payment")) window.history.replaceState(null, "", window.location.pathname);
            await loadActivity();
            updateSummary();
        } catch (err) {
            PE.toast(err.message, "error");
        }
    })();
})();
