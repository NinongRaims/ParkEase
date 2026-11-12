// Runs in <head> so the saved theme is applied before the page paints (no light flash).
(function () {
    try {
        if (localStorage.getItem("pe-theme") === "dark") {
            document.documentElement.classList.add("dark-mode");
        }
    } catch (e) { /* storage blocked: stay on the light theme */ }
})();
