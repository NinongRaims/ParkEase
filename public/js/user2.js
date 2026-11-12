/* Slots Available page: live availability per establishment */
(function () {
    "use strict";
    async function load() {
        const list = await PE.api("/api/establishments");
        const box = document.getElementById("establishment-list");
        if (!list.length) {
            box.replaceChildren(PE.el("p", { class: "empty-note", text: "No establishments are open for reservations right now." }));
            return;
        }
        box.replaceChildren(...list.map((e) => PE.el("div", { class: "establishment-card" }, [
            PE.el("div", { class: "establishment-image" }, [
                PE.el("img", { src: e.image || "Images/ParkEaseLogo.png", alt: e.name }),
            ]),
            PE.el("div", { class: "establishment-details" }, [
                PE.el("h3", { text: e.name }),
                PE.el("div", { class: "available-slots" }, [
                    PE.el("span", { text: "SLOTS -" }),
                    PE.el("span", { class: "slot-count", text: String(e.available_slots) }),
                    PE.el("span", { text: "Available" }),
                ]),
            ]),
        ])));
    }
    PE.poll(load, 30000);
})();
