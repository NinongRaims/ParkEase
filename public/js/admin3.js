/* Admin > Establishments */
(function () {
    "use strict";
    const body = document.getElementById("establishments-body");

    async function setStatus(est, status) {
        try {
            await PE.api(`/api/admin/establishments/${est.id}`, { method: "PATCH", body: { status } });
            PE.toast(`${est.name} is now ${status.toLowerCase()}.`, "success");
            await load();
        } catch (err) { PE.toast(err.message, "error"); }
    }

    async function load() {
        const list = await PE.api("/api/admin/establishments");
        if (!list.length) {
            body.replaceChildren(PE.emptyRow(6, "No establishments yet."));
            return;
        }
        body.replaceChildren(...list.map((e) => {
            const next = e.status === "Active" ? "Inactive" : "Active";
            return PE.el("tr", {}, [
                PE.el("td", { text: e.code }),
                PE.el("td", { text: e.name }),
                PE.el("td", { text: e.location }),
                PE.el("td", { text: e.contact_number || "–" }),
                PE.el("td", { text: e.reservations }),
                PE.el("td", {}, [PE.el("button", {
                    type: "button", class: "status-toggle " + e.status.toLowerCase(),
                    title: `Click to set ${next.toLowerCase()}`,
                    onclick: () => setStatus(e, next),
                }, [e.status])]),
            ]);
        }));
    }
    PE.poll(load, 60000);
})();
