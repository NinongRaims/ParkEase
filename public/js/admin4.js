/* Admin > Reports */
(function () {
    "use strict";
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
        "September", "October", "November", "December"];
    const range = document.getElementById("report-range");

    const monthLabel = (ym) => `${MONTHS[parseInt(ym.slice(5, 7), 10) - 1]} ${ym.slice(0, 4)}`;

    async function load() {
        const d = await PE.api(`/api/admin/reports?months=${encodeURIComponent(range.value)}`);

        const mBody = document.getElementById("months-body");
        mBody.replaceChildren(...(d.months.length ? d.months.map((m) => PE.el("tr", {}, [
            PE.el("td", { text: monthLabel(m.month) }),
            PE.el("td", { text: m.reservations }),
            PE.el("td", { text: PE.peso(m.revenue) }),
            PE.el("td", { text: PE.peso(m.commission) }),
        ])) : [PE.emptyRow(4, "No reservations in this period.")]));

        const eBody = document.getElementById("by-establishment-body");
        eBody.replaceChildren(...(d.establishments.length ? d.establishments.map((e) => PE.el("tr", {}, [
            PE.el("td", { text: e.name }),
            PE.el("td", { text: e.reservations }),
            PE.el("td", { text: PE.peso(e.revenue) }),
            PE.el("td", { text: `${e.commission_rate}%` }),
            PE.el("td", { text: PE.peso(e.commission) }),
        ])) : [PE.emptyRow(5, "No establishments yet.")]));
    }

    range.addEventListener("change", () => load().catch((e) => PE.toast(e.message, "error")));
    PE.poll(load, 60000);
})();
