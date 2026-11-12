/* Parking Slots page: see live slot states, add / disable / delete slots */
(function () {
    "use strict";
    const grid = document.getElementById("slots-grid");
    const LABELS = { available: "Available", reserved: "Reserved", occupied: "Occupied", maintenance: "Maintenance" };

    async function load() {
        const { slots } = await PE.api("/api/establishment/slots");
        if (!slots.length) {
            grid.replaceChildren(PE.el("p", { class: "empty-note", text: "No parking slots yet. Add your first one above." }));
            return;
        }
        grid.replaceChildren(...slots.map((s) => PE.el("div", { class: "slot-card " + s.state }, [
            PE.el("strong", { text: s.code }),
            PE.el("span", { class: "status " + s.state, text: LABELS[s.state] }),
            PE.el("div", { class: "slot-actions" }, [
                PE.el("button", {
                    type: "button", class: "slot-btn", disabled: s.state === "occupied",
                    title: s.is_active ? "Take this slot out of service" : "Put this slot back in service",
                    onclick: () => update(s, !s.is_active),
                }, [s.is_active ? "Disable" : "Enable"]),
                PE.el("button", {
                    type: "button", class: "slot-btn danger", title: "Delete slot",
                    "aria-label": "Delete slot " + s.code, onclick: () => remove(s),
                }, [PE.el("i", { class: "fa-solid fa-trash" })]),
            ]),
        ])));
    }

    async function update(slot, active) {
        try {
            await PE.api(`/api/establishment/slots/${slot.id}`, { method: "PATCH", body: { is_active: active } });
            PE.toast(`Slot ${slot.code} ${active ? "enabled" : "set to maintenance"}.`, "success");
            await load();
        } catch (err) { PE.toast(err.message, "error"); }
    }

    async function remove(slot) {
        if (!window.confirm(`Delete slot ${slot.code}? This cannot be undone.`)) return;
        try {
            await PE.api(`/api/establishment/slots/${slot.id}`, { method: "DELETE" });
            PE.toast(`Slot ${slot.code} deleted.`, "success");
            await load();
        } catch (err) { PE.toast(err.message, "error"); }
    }

    document.getElementById("add-slot-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("new-slot-code");
        try {
            await PE.api("/api/establishment/slots", { method: "POST", body: { code: input.value } });
            PE.toast(`Slot ${input.value.trim().toUpperCase()} added.`, "success");
            input.value = "";
            await load();
        } catch (err) { PE.toast(err.message, "error"); }
    });

    /* map location */
    const locForm = document.getElementById("location-form");
    const addr = document.getElementById("loc-address"), lat = document.getElementById("loc-lat"), lng = document.getElementById("loc-lng");
    PE.api("/api/establishment/location").then((l) => {
        addr.value = l.address || "";
        lat.value = l.latitude ?? "";
        lng.value = l.longitude ?? "";
    }).catch((err) => PE.toast(err.message, "error"));

    document.getElementById("loc-here").addEventListener("click", () => {
        if (!navigator.geolocation) return PE.toast("Your browser can't share your location.", "error");
        navigator.geolocation.getCurrentPosition((pos) => {
            lat.value = pos.coords.latitude.toFixed(6);
            lng.value = pos.coords.longitude.toFixed(6);
            PE.toast("Location filled in. Press Save location to keep it.");
        }, () => PE.toast("Couldn't get your location.", "error"), { enableHighAccuracy: true, timeout: 15000 });
    });

    locForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await PE.api("/api/establishment/location", { method: "PUT",
                body: { address: addr.value, latitude: lat.value, longitude: lng.value } });
            PE.toast("Map location saved.", "success");
        } catch (err) { PE.toast(err.message, "error"); }
    });

    PE.poll(load, 30000);
})();
