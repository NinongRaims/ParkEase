/* Password reset page: opened from the link in the reset e-mail (reset.html?token=...). */
(function () {
    "use strict";
    const form = document.getElementById("reset-form");
    const msg = document.getElementById("reset-message");
    const button = document.getElementById("reset-button");
    const token = new URLSearchParams(window.location.search).get("token") || "";

    function show(text, ok) {
        msg.textContent = text || "";
        msg.className = "form-message" + (text ? (ok ? " success" : " error") : "");
    }

    // Take the secret out of the address bar / history as soon as we've read it.
    try { window.history.replaceState(null, "", window.location.pathname); } catch (e) { /* ignore */ }

    if (!token) {
        form.querySelector(".email-pass").classList.add("hidden");
        button.classList.add("hidden");
        show("This reset link is missing its token. Please request a new one from the login page.");
    }

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pass = document.getElementById("new-password").value;
        if (pass.length < 8) return show("Password must be at least 8 characters.");
        if (pass !== document.getElementById("confirm-password").value) return show("Passwords do not match.");
        button.disabled = true;
        button.textContent = "PLEASE WAIT…";
        try {
            await PE.api("/api/password/reset", { method: "POST", allow401: true, body: { token, password: pass } });
            form.querySelector(".email-pass").classList.add("hidden");
            button.classList.add("hidden");
            show("Your password has been changed. You can now log in with it.", true);
            document.getElementById("back-to-login").textContent = "Go to login";
        } catch (err) {
            show(err.message);
            button.disabled = false;
            button.textContent = "RESET PASSWORD";
        }
    });
})();
