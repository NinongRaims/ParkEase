/* Admin > Users */
(function () {
    "use strict";
    const body = document.getElementById("users-body");

    async function setStatus(user, status) {
        try {
            await PE.api(`/api/admin/users/${user.id}`, { method: "PATCH", body: { status } });
            PE.toast(`${user.name} is now ${status.toLowerCase()}.`, "success");
            await load();
        } catch (err) { PE.toast(err.message, "error"); }
    }

    async function load() {
        const users = await PE.api("/api/admin/users");
        if (!users.length) {
            body.replaceChildren(PE.emptyRow(6, "No users have registered yet."));
            return;
        }
        body.replaceChildren(...users.map((u) => {
            const next = u.status === "Active" ? "Inactive" : "Active";
            return PE.el("tr", {}, [
                PE.el("td", { text: u.code }),
                PE.el("td", { text: u.name }),
                PE.el("td", { text: u.email }),
                PE.el("td", { text: u.contact_number || "–" }),
                PE.el("td", { text: PE.fmtDate(u.created_at + " 00:00") }),
                PE.el("td", {}, [PE.el("button", {
                    type: "button", class: "status-toggle " + u.status.toLowerCase(),
                    title: `Click to set ${next.toLowerCase()}`,
                    onclick: () => setStatus(u, next),
                }, [u.status])]),
            ]);
        }));
    }
    PE.poll(load, 60000);
})();
