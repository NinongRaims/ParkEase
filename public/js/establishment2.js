/* Establishment reservations table */
(function () {
    "use strict";
    async function load() {
        const rows = await PE.api("/api/establishment/reservations");
        const body = document.getElementById("reservations-body");
        if (!rows.length) {
            body.replaceChildren(PE.emptyRow(7, "No reservations yet."));
            return;
        }
        body.replaceChildren(...rows.map((r) => PE.el("tr", {}, [
            PE.el("td", { text: r.code }),
            PE.el("td", { text: r.customer }),
            PE.el("td", { text: r.slot }),
            PE.el("td", { text: PE.fmtDate(r.start_at) }),
            PE.el("td", { text: PE.fmtTime(r.start_at) }),
            PE.el("td", { text: PE.fmtDuration(PE.minutesBetween(r.start_at, r.end_at)) }),
            PE.el("td", {}, [PE.statusChip(r.status)]),
        ])));
    }
    PE.poll(load, 30000);
})();
