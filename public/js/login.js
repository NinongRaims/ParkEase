(function () {
    "use strict";
    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");
    const loginMsg = document.getElementById("login-message");
    const registerMsg = document.getElementById("register-message");
    const forgotForm = document.getElementById("forgot-form");
    const forgotMsg = document.getElementById("forgot-message");

    function showMessage(node, text, ok) {
        node.textContent = text || "";
        node.className = "form-message" + (text ? (ok ? " success" : " error") : "");
    }

    function setBusy(button, busy, label) {
        button.disabled = busy;
        button.textContent = busy ? "PLEASE WAIT…" : label;
    }

    /* show / hide password */
    const password = document.getElementById("password");
    const showPassword = document.getElementById("show-password");
    showPassword.addEventListener("click", function () {
        const hidden = password.type === "password";
        password.type = hidden ? "text" : "password";
        showPassword.innerHTML = hidden
            ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
        showPassword.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
    });

    /* switch between login and register */
    function show(which) {
        loginForm.classList.toggle("hidden", which !== "login");
        registerForm.classList.toggle("hidden", which !== "register");
        forgotForm.classList.toggle("hidden", which !== "forgot");
        showMessage(loginMsg, "");
        showMessage(registerMsg, "");
        showMessage(forgotMsg, "");
    }
    document.getElementById("show-register").addEventListener("click", (e) => { e.preventDefault(); show("register"); });
    document.getElementById("show-login").addEventListener("click", (e) => { e.preventDefault(); show("login"); });
    document.getElementById("forgot-password").addEventListener("click", (e) => {
        e.preventDefault();
        show("forgot");
        document.getElementById("forgot-email").value = document.getElementById("email").value.trim();
    });
    document.getElementById("forgot-back").addEventListener("click", (e) => { e.preventDefault(); show("login"); });

    /* forgot password: e-mail a reset link */
    forgotForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const button = document.getElementById("forgot-button");
        const email = document.getElementById("forgot-email").value.trim();
        if (!email) return showMessage(forgotMsg, "Please enter your email.");
        setBusy(button, true, "SEND RESET LINK");
        try {
            const res = await PE.api("/api/password/forgot", { method: "POST", body: { email }, allow401: true });
            showMessage(forgotMsg, res.message, true);
        } catch (err) {
            showMessage(forgotMsg, err.message);
        }
        setBusy(button, false, "SEND RESET LINK");
    });

    /* login */
    async function login(email, pass, remember) {
        const button = document.getElementById("login-button");
        showMessage(loginMsg, "");
        if (!email || !pass) return showMessage(loginMsg, "Please enter your email and password.");
        setBusy(button, true, "LOGIN");
        try {
            const res = await PE.api("/api/login", {
                method: "POST", body: { email, password: pass, remember }, allow401: true,
            });
            window.location.href = res.redirect;
        } catch (err) {
            showMessage(loginMsg, err.message);
            setBusy(button, false, "LOGIN");
        }
    }

    loginForm.addEventListener("submit", (e) => {
        e.preventDefault();
        login(document.getElementById("email").value.trim(), password.value,
            document.getElementById("remember").checked);
    });

    /* register */
    registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const button = document.getElementById("register-button");
        const get = (id) => document.getElementById(id).value.trim();
        const pass = document.getElementById("reg-password").value;
        showMessage(registerMsg, "");

        if (pass !== document.getElementById("reg-confirm").value) {
            return showMessage(registerMsg, "Passwords do not match.");
        }
        const newEmail = get("reg-email");
        setBusy(button, true, "CREATE ACCOUNT");
        try {
            await PE.api("/api/register", {
                method: "POST", allow401: true,
                body: {
                    first_name: get("reg-first"), last_name: get("reg-last"), email: get("reg-email"),
                    contact_number: get("reg-contact"), password: pass,
                },
            });
            registerForm.reset();
            show("login");
            document.getElementById("email").value = newEmail;
            showMessage(loginMsg, "Account created! You can log in now.", true);
        } catch (err) {
            showMessage(registerMsg, err.message);
        }
        setBusy(button, false, "CREATE ACCOUNT");
    });
})();
