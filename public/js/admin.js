/* Admin dashboard */
(function () {
    "use strict";
    async function load() {
        const d = await PE.api("/api/admin/dashboard");
        PE.setText("stat-commission", PE.peso(d.total_commission));
        PE.setText("stat-users", d.total_users);
        PE.setText("stat-establishments", d.total_establishments);
        const body = document.getElementById("commission-body");
        if (!d.establishments.length) {
            body.replaceChildren(PE.emptyRow(4, "No establishments yet."));
            return;
        }
        body.replaceChildren(...d.establishments.map((e) => PE.el("tr", {}, [
            PE.el("td", { text: e.name }),
            PE.el("td", { text: e.reservations }),
            PE.el("td", { text: PE.peso(e.revenue) }),
            PE.el("td", { text: `${e.commission_rate}%` }),
        ])));
    }
    PE.poll(load, 30000);
})();
