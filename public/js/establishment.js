/* Establishment overview: live numbers from the database */
(function () {
    "use strict";
    async function load() {
        const d = await PE.api("/api/establishment/overview");
        PE.setText("stat-revenue", PE.peso(d.revenue));
        PE.setText("stat-total", d.reservations_total);
        PE.setText("stat-available", d.slots_available);
        PE.setText("stat-incoming", d.incoming);
        PE.setText("stat-completed", d.completed);
        PE.setText("stat-reserved", d.slots_reserved);
        PE.setText("stat-occupied", d.slots_occupied);
    }
    PE.poll(load, 30000);
})();
