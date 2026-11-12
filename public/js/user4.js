/* Find Parking: parking areas on an OpenStreetMap map (Leaflet) with directions in Google Maps */
(function () {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const list = $("map-list"), note = $("map-note");
    const DEFAULT_CENTER = [15.4817, 120.5979]; // Tarlac City, used until pins are available
    let map = null, places = [], markers = new Map(), me = null, meMarker = null;

    const gmapsDirections = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.latitude},${p.longitude}`;
    const gmapsOpen = (p) => `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`;

    function km(a, b) { // haversine distance in kilometres
        const rad = (d) => (d * Math.PI) / 180, R = 6371;
        const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(x));
    }
    const fmtKm = (d) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`);

    function details(p, withDistance) {
        return [
            PE.el("h3", { text: p.name }),
            PE.el("p", { text: p.address }),
            PE.el("div", { class: "place-meta" }, [
                PE.el("span", { text: `${PE.peso(p.hourly_rate)} / hour` }),
                PE.el("span", { text: `${p.available_slots} of ${p.total_slots} slots free` }),
                withDistance && p.distance !== undefined ? PE.el("span", { class: "distance", text: fmtKm(p.distance) + " away" }) : null,
            ]),
            PE.el("div", { class: "place-actions" }, [
                p.latitude !== null ? PE.el("a", { href: gmapsDirections(p), target: "_blank", rel: "noopener noreferrer" }, [
                    PE.el("i", { class: "fa-solid fa-diamond-turn-right" }), " Directions"]) : null,
                p.latitude !== null ? PE.el("a", { class: "secondary", href: gmapsOpen(p), target: "_blank", rel: "noopener noreferrer", text: "Open in Google Maps" }) : null,
                PE.el("a", { class: "secondary", href: `/user.html?location=${p.id}`, text: "Reserve here" }),
            ]),
        ];
    }

    function renderList() {
        list.replaceChildren(...places.map((p) => {
            const card = PE.el("div", { class: "place-card", tabindex: "0", role: "button", "aria-label": `Show ${p.name} on the map` }, details(p, true));
            const focus = () => {
                const m = markers.get(p.id);
                if (m && map) { map.flyTo(m.getLatLng(), 16); m.openPopup(); }
            };
            card.addEventListener("click", (e) => { if (!e.target.closest("a")) focus(); });
            card.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.target.closest("a")) focus(); });
            return card;
        }));
    }

    function drawMarkers() {
        if (!map) return;
        markers.forEach((m) => m.remove());
        markers = new Map();
        places.filter((p) => p.latitude !== null).forEach((p) => {
            const m = window.L.marker([p.latitude, p.longitude]).addTo(map);
            m.bindPopup(PE.el("div", {}, details(p, true)), { minWidth: 220 });
            markers.set(p.id, m);
        });
        const pts = [...markers.values()].map((m) => m.getLatLng());
        if (me) pts.push(window.L.latLng(me.latitude, me.longitude));
        if (pts.length === 1) map.setView(pts[0], 15);
        else if (pts.length > 1) map.fitBounds(window.L.latLngBounds(pts), { padding: [40, 40] });
    }

    function sortByDistance() {
        places.forEach((p) => { p.distance = me && p.latitude !== null ? km(me, p) : undefined; });
        places.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.name.localeCompare(b.name));
    }

    async function load() {
        places = await PE.api("/api/parking-locations");
        if (me) sortByDistance();
        renderList();
        drawMarkers();
        const missing = places.filter((p) => p.latitude === null).length;
        note.textContent = missing ? `${missing} parking area(s) haven't set a map pin yet and are only listed.` : "";
        if (!places.length) list.replaceChildren(PE.el("p", { class: "empty-note", text: "No parking areas are open right now." }));
    }

    $("near-me").addEventListener("click", () => {
        if (!navigator.geolocation) return PE.toast("Your browser can't share your location.", "error");
        const btn = $("near-me");
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition((pos) => {
            btn.disabled = false;
            me = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
            if (map) {
                if (meMarker) meMarker.remove();
                meMarker = window.L.circleMarker([me.latitude, me.longitude], { radius: 9, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 })
                    .addTo(map).bindTooltip("You are here");
            }
            sortByDistance();
            renderList();
            drawMarkers();
        }, () => {
            btn.disabled = false;
            PE.toast("Couldn't get your location. Allow location access in your browser and try again.", "error");
        }, { enableHighAccuracy: true, timeout: 15000 });
    });

    if (window.L) {
        map = window.L.map("map").setView(DEFAULT_CENTER, 13);
        window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);
    } else {
        $("map").textContent = "The map couldn't be loaded (check your internet connection). You can still use the list and the Directions links.";
        $("map").style.padding = "20px";
    }
    PE.poll(load, 60000);
})();
