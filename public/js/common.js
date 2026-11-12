/* ParkEase shared front-end helpers: API calls, formatting, toasts, side panel,
   dark mode and the account menu (with logout). Loaded on every page. */
(function () {
    "use strict";
    const PE = (window.PE = {});

    /* ---------- API ---------- */
    PE.api = async function (url, options) {
        const opts = options || {};
        const init = {
            method: opts.method || "GET",
            credentials: "same-origin",
            headers: { "X-Requested-With": "ParkEase" },
        };
        if (opts.body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(opts.body);
        }
        let res;
        try {
            res = await fetch(url, init);
        } catch (e) {
            throw new Error("Can't reach the server. Check your connection and try again.");
        }
        let data = null;
        try { data = await res.json(); } catch (e) { /* non-JSON body */ }
        if (res.status === 401 && !opts.allow401) {
            window.location.href = "/";
            throw new Error("Please log in to continue.");
        }
        if (!res.ok) throw new Error((data && data.error) || "Something went wrong.");
        return data;
    };


    /* ---------- page guard ----------
       On Netlify the HTML files are static, so the role check that Flask used to do before serving a
       page happens here instead. (Data is still protected on the server by the /api/* role checks.) */
    (function guard() {
        const file = (location.pathname.split("/").pop() || "index.html").toLowerCase();
        const HOME = { user: "/user.html", establishment: "/establishment.html", admin: "/admin.html" };
        const m = file.match(/^(user|establishment|admin)\d*\.html$/);
        const isLogin = file === "index.html" || file === "";
        if (!m && !isLogin) return;                       // reset.html etc. work logged out
        PE.api("/api/me", { allow401: true }).then((me) => {
            if (isLogin && me && me.role) location.replace(HOME[me.role] || "/");
            else if (m && me && me.role && me.role !== m[1]) location.replace(HOME[me.role] || "/");
        }).catch(() => { if (m) location.replace("/"); });
    })();

    let mePromise = null;
    PE.me = function () {
        if (!mePromise) mePromise = PE.api("/api/me");
        return mePromise;
    };

    /* ---------- formatting ---------- */
    const pad = (n) => String(n).padStart(2, "0");
    PE.peso = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Server times look like "2026-11-10 13:00"; build dates by hand to avoid timezone shifts.
    PE.fmtDate = (s) => `${s.slice(5, 7)}-${s.slice(8, 10)}-${s.slice(0, 4)}`;
    PE.fmtTime = (s) => {
        const h = parseInt(s.slice(11, 13), 10);
        return `${pad(h % 12 === 0 ? 12 : h % 12)}:${s.slice(14, 16)} ${h < 12 ? "AM" : "PM"}`;
    };
    // Accepts "HH:MM" times or full "YYYY-MM-DD HH:MM" stamps (which may span midnight).
    const toMs = (s) => s.length > 5
        ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16))
        : +s.slice(0, 2) * 3600000 + +s.slice(3, 5) * 60000;
    PE.minutesBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 60000);
    PE.fmtDuration = (mins) => {
        const h = Math.floor(mins / 60), m = mins % 60, parts = [];
        if (h) parts.push(`${h} ${h === 1 ? "Hour" : "Hours"}`);
        if (m) parts.push(`${m} Minutes`);
        return parts.join(" ") || "0 Minutes";
    };
    PE.fmtHM = (mins) => `${Math.floor(mins / 60)}:${pad(mins % 60)}`;
    PE.cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    /* ---------- DOM helpers (textContent only, so data can never inject HTML) ---------- */
    PE.el = function (tag, attrs, children) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => {
            if (v === null || v === undefined || v === false) return;
            if (k === "class") node.className = v;
            else if (k === "text") node.textContent = v;
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? "" : v);
        });
        [].concat(children || []).forEach((c) => {
            if (c !== null && c !== undefined) node.append(c.nodeType ? c : document.createTextNode(c));
        });
        return node;
    };
    PE.setText = (id, value) => { const n = document.getElementById(id); if (n) n.textContent = value; };

    PE.statusChip = (status) => PE.el("span", { class: "status " + status, text: PE.cap(status) });

    PE.emptyRow = (cols, text) =>
        PE.el("tr", {}, [PE.el("td", { colspan: cols, class: "empty-cell", text })]);

    /* ---------- toast ---------- */
    let toastTimer;
    PE.toast = function (message, type) {
        let box = document.getElementById("pe-toast");
        if (!box) {
            box = PE.el("div", { id: "pe-toast", role: "status", "aria-live": "polite" });
            document.body.append(box);
        }
        box.textContent = message;
        box.className = "show " + (type || "info");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (box.className = ""), 4000);
    };

    /* ---------- refresh helper (pauses while the tab is hidden) ---------- */
    PE.poll = function (fn, ms) {
        fn().catch((e) => PE.toast(e.message, "error"));
        setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, ms);
    };

    /* ---------- shared page chrome ---------- */
    document.querySelectorAll(".menu-item").forEach((item) => {
        item.addEventListener("click", function () {
            document.querySelectorAll(".menu-item").forEach((m) => m.classList.remove("active"));
            this.classList.add("active");
        });
    });

    const headerLinks = document.querySelectorAll(".right-section a");
    headerLinks.forEach((link) => {
        link.addEventListener("click", function (e) {
            if (this.getAttribute("href") === "#") e.preventDefault();
            headerLinks.forEach((l) => l.classList.remove("active"));
            this.classList.add("active");
        });
    });

    const sideToggle = document.getElementById("side-toggle");
    if (sideToggle && window.innerWidth <= 600) sideToggle.checked = true;

    // Dark mode: the class lives on <html> (set early by theme.js) and is remembered.
    const darkBtn = document.getElementById("darkModeToggle");
    if (darkBtn) {
        const icon = darkBtn.querySelector("i");
        const sync = () => {
            const dark = document.documentElement.classList.contains("dark-mode");
            icon.classList.toggle("fa-sun", dark);
            icon.classList.toggle("fa-moon", !dark);
        };
        sync();
        darkBtn.addEventListener("click", () => {
            const dark = document.documentElement.classList.toggle("dark-mode");
            try { localStorage.setItem("pe-theme", dark ? "dark" : "light"); } catch (e) { /* ignore */ }
            sync();
        });
    }

    /* ---------- account menu + logout ---------- */
    const accountLink = document.getElementById("account-link");
    if (accountLink) {
        const menu = PE.el("div", { id: "account-menu", hidden: true });
        document.body.append(menu);

        const close = () => { menu.hidden = true; accountLink.classList.remove("active"); };
        accountLink.addEventListener("click", async (e) => {
            e.preventDefault();
            if (!menu.hidden) return close();
            document.dispatchEvent(new CustomEvent("pe-panel", { detail: "account" }));
            try {
                const me = await PE.me();
                menu.replaceChildren(
                    PE.el("strong", { text: `${me.first_name} ${me.last_name}` }),
                    PE.el("span", { text: me.email }),
                    PE.el("span", { class: "role-tag", text: PE.cap(me.role) }),
                    PE.el("button", { type: "button", id: "logout-button", onclick: async () => {
                        try { await PE.api("/api/logout", { method: "POST" }); } catch (err) { /* leave anyway */ }
                        window.location.href = "/";
                    } }, [PE.el("i", { class: "fa-solid fa-right-from-bracket" }), " Log out"])
                );
                menu.hidden = false;
            } catch (err) { PE.toast(err.message, "error"); }
        });
        document.addEventListener("click", (e) => {
            if (!menu.hidden && !menu.contains(e.target) && !accountLink.contains(e.target)) close();
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
        document.addEventListener("pe-panel", (e) => { if (e.detail !== "account") close(); });
    }

    /* ---------- modal dialog (About, Contact) ---------- */
    PE.modal = function (title, content) {
        const previous = document.activeElement;
        const close = () => {
            overlay.remove();
            document.removeEventListener("keydown", onKey);
            if (previous && previous.focus) previous.focus();
        };
        const onKey = (e) => { if (e.key === "Escape") close(); };
        const dialog = PE.el("div", { class: "pe-modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [
            PE.el("button", { type: "button", class: "pe-modal-close", "aria-label": "Close", onclick: close }, [
                PE.el("i", { class: "fa-solid fa-xmark" })]),
            PE.el("h2", { text: title }),
            ...[].concat(content),
        ]);
        const overlay = PE.el("div", { class: "pe-modal-overlay", onmousedown: (e) => { if (e.target === overlay) close(); } }, [dialog]);
        document.body.append(overlay);
        document.addEventListener("keydown", onKey);
        const first = dialog.querySelector("input, textarea, button.pe-modal-close");
        if (first) first.focus();
        return { close, dialog };
    };

    /* ---------- header: About ---------- */
    const aboutLink = document.getElementById("about-link");
    if (aboutLink) {
        aboutLink.addEventListener("click", (e) => {
            e.preventDefault();
            const p = (t) => PE.el("p", { text: t });
            PE.modal("About ParkEase", [
                p("ParkEase is a parking reservation service. Drivers find a parking area, reserve a slot for the " +
                  "time they need and pay online. Parking establishments manage their slots and see every booking, " +
                  "and the ParkEase team looks after accounts, commissions and reports."),
                PE.el("h3", { text: "How booking works" }),
                PE.el("ol", {}, [
                    PE.el("li", { text: "Choose a location, slot, date and arrival / departure time, then press Reserve." }),
                    PE.el("li", { text: "Review the price (hourly rate, partial hours rounded up) and press Pay Now." }),
                    PE.el("li", { text: "Pay securely with GCash, Maya or a card. Your booking is confirmed as soon as the payment is." }),
                    PE.el("li", { text: "Need to change plans? Cancel from My Bookings before your arrival time." }),
                ]),
                PE.el("h3", { text: "Cancellations & refunds" }),
                p("Bookings cancelled with enough notice are refunded in full to the original payment method. " +
                  "You'll see the exact refund result when you cancel."),
                PE.el("h3", { text: "Questions?" }),
                p("Use Contact in the header and we'll reply by email."),
            ]);
        });
    }

    /* ---------- header: Contact ---------- */
    const contactLink = document.getElementById("contact-link");
    if (contactLink) {
        contactLink.addEventListener("click", async (e) => {
            e.preventDefault();
            let me = null;
            try { me = await PE.me(); } catch (err) { return; }
            const subject = PE.el("input", { type: "text", id: "contact-subject", maxlength: "120", placeholder: "Subject", required: true });
            const message = PE.el("textarea", { id: "contact-message", maxlength: "2000", rows: "6", placeholder: "How can we help?", required: true });
            const note = PE.el("p", { class: "pe-modal-note", text: `We'll reply to ${me.email}.` });
            const send = PE.el("button", { type: "submit", class: "pe-btn", text: "Send message" });
            const form = PE.el("form", { class: "pe-form", novalidate: true }, [subject, message, note, send]);
            const modal = PE.modal("Contact us", [form]);
            form.addEventListener("submit", async (ev) => {
                ev.preventDefault();
                if (!subject.value.trim() || message.value.trim().length < 10) {
                    return PE.toast("Please add a subject and a message of at least 10 characters.", "error");
                }
                send.disabled = true;
                try {
                    await PE.api("/api/contact", { method: "POST", body: { subject: subject.value, message: message.value } });
                    modal.close();
                    PE.toast("Message sent. We'll get back to you by email.", "success");
                    refreshNotifications();
                } catch (err) {
                    PE.toast(err.message, "error");
                    send.disabled = false;
                }
            });
        });
    }

    /* ---------- header: Notifications ---------- */
    const notifLink = document.getElementById("notifications-link");
    let refreshNotifications = () => {};
    if (notifLink) {
        const badge = PE.el("span", { class: "notif-badge", hidden: true });
        notifLink.append(badge);
        const panel = PE.el("div", { id: "notif-panel", hidden: true, role: "region", "aria-label": "Notifications" });
        document.body.append(panel);

        const stamp = (s) => `${PE.fmtDate(s)} ${PE.fmtTime(s)}`;
        const setBadge = (n) => { badge.textContent = n > 99 ? "99+" : String(n); badge.hidden = n === 0; };
        const closePanel = () => { panel.hidden = true; notifLink.classList.remove("active"); };

        async function render() {
            const data = await PE.api("/api/notifications");
            setBadge(data.unread);
            const head = PE.el("div", { class: "notif-head" }, [
                PE.el("strong", { text: "Notifications" }),
                PE.el("button", { type: "button", class: "notif-readall", disabled: data.unread === 0, text: "Mark all as read",
                    onclick: async () => { await PE.api("/api/notifications/read", { method: "POST", body: {} }); render(); } }),
            ]);
            const items = data.items.length ? data.items.map((n) => PE.el("div", {
                class: "notif-item" + (n.read ? "" : " unread"), tabindex: "0",
                onclick: async () => {
                    if (n.read) return;
                    await PE.api("/api/notifications/read", { method: "POST", body: { id: n.id } });
                    render();
                },
            }, [
                PE.el("strong", { text: n.title }),
                n.body ? PE.el("span", { text: n.body }) : null,
                PE.el("time", { text: stamp(n.created_at) }),
            ])) : [PE.el("p", { class: "notif-empty", text: "You're all caught up." })];
            panel.replaceChildren(head, PE.el("div", { class: "notif-list" }, items));
        }
        refreshNotifications = () => render().catch(() => {});

        notifLink.addEventListener("click", async (e) => {
            e.preventDefault();
            if (!panel.hidden) return closePanel();
            document.dispatchEvent(new CustomEvent("pe-panel", { detail: "notifications" }));
            try { await render(); panel.hidden = false; } catch (err) { PE.toast(err.message, "error"); }
        });
        document.addEventListener("click", (e) => {
            if (!panel.hidden && !panel.contains(e.target) && !notifLink.contains(e.target)) closePanel();
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
        document.addEventListener("pe-panel", (e) => { if (e.detail !== "notifications") closePanel(); });

        // keep the unread badge fresh (pauses while the tab is hidden)
        const tick = () => { if (!document.hidden && panel.hidden) refreshNotifications(); };
        tick();
        setInterval(tick, 45000);
    }
})();
