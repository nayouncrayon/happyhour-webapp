/*
 * app.js — everything you see on the page: day tabs, filters, the list, and the map.
 * Data loading and status logic live in data.js; this file only reads the model it builds.
 *
 * Flow: start() → HH.loadData() → render() whenever the day, view, or filters change
 * (and once a minute, so "On now · 20 min left" stays current).
 */
(function () {
  const config = window.HH_CONFIG;
  const $ = (sel) => document.querySelector(sel);

  /* ---------- state ---------- */

  const DEFAULT_FILTERS = {
    neighborhoods: [],   // empty = all
    prices: [],          // empty = all
    deals: "any",        // "any" | "food" | "drinks"
    hideBarOnly: false,  // for groups who want a table
    showSpecials: true,  // day specials (Taco Tuesday…) and events
  };
  const STORAGE_KEY = "hh-preferences-v1";

  const state = {
    model: null,
    source: "sample",
    now: HH.nowIn(config.TIME_ZONE),
    day: HH.nowIn(config.TIME_ZONE).day,
    view: "list",
    filters: { ...DEFAULT_FILTERS },
    expanded: new Set(), // schedule IDs whose full deal list is open
  };

  // Remember view + filters on this device (never required; fails quietly in private mode).
  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.view === "list" || saved.view === "map") state.view = saved.view;
      if (saved.filters) state.filters = { ...DEFAULT_FILTERS, ...saved.filters };
    } catch (e) { /* ignore */ }
  }
  function savePrefs() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ view: state.view, filters: state.filters })); }
    catch (e) { /* ignore */ }
  }

  /* ---------- helpers ---------- */

  // Sheet text is inserted into the page, so always escape it.
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "");
  const telUrl = (p) => { const d = String(p || "").replace(/[^\d+]/g, ""); return d.length >= 10 ? `tel:${d}` : ""; };
  const directionsUrl = (spot) => safeUrl(spot.mapsUrl) ||
    (spot.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(spot.name + " " + spot.address)}` : "");
  const isBarOnly = (seating) => /bar|counter|lounge/i.test(seating || "") && !/whole|patio/i.test(seating || "");
  const isSpecial = (s) => /special|event/i.test(s.kind);

  /* ---------- filtering + grouping ---------- */

  function passesFilters(s) {
    const f = state.filters;
    if (f.neighborhoods.length && !f.neighborhoods.includes(s.spot.neighborhood)) return false;
    if (f.prices.length && !f.prices.includes(s.spot.price)) return false;
    if (f.deals === "food" && !s.hasFood) return false;
    if (f.deals === "drinks" && (s.hasFood || !s.deals.length)) return false;
    if (f.hideBarOnly && isBarOnly(s.seating)) return false;
    if (!f.showSpecials && isSpecial(s)) return false;
    return true;
  }

  /** Schedules for the selected day, with status, split into display groups. */
  function groupsForDay() {
    const isToday = state.day === state.now.day;
    const rows = state.model.schedules
      .filter((s) => s.hasDays && s.days[state.day] && passesFilters(s))
      .map((s) => ({ s, st: HH.statusFor(s, state.day, state.now, config) }));
    const sortRows = (list, key = (r) => r.st.sortKey) =>
      list.sort((a, b) => key(a) - key(b) || a.s.spot.name.localeCompare(b.s.spot.name));
    const byState = (...states) => rows.filter((r) => states.includes(r.st.state));

    const undated = state.model.schedules
      .filter((s) => !s.hasDays && passesFilters(s))
      .map((s) => ({ s, st: { state: "unknown", label: "Days not listed", sortKey: 0 } }));

    if (isToday) {
      return [
        { title: "On now", rows: sortRows(byState("now")), tone: "now" },
        { title: "Starting soon", rows: sortRows(byState("soon")), tone: "soon" },
        { title: "Later today", rows: sortRows(byState("later")) },
        { title: "Hours not listed", rows: sortRows(byState("unknown")), collapsible: true },
        { title: "Ended earlier", rows: sortRows(byState("ended")), collapsible: true, dim: true },
        { title: "Days not listed", rows: sortRows(undated, (r) => r.s.start ?? 9999), collapsible: true },
      ];
    }
    return [
      { title: `${HH.DAY_NAMES[state.day]} happy hours`, rows: sortRows(byState("scheduled")) },
      { title: "Hours not listed", rows: sortRows(byState("unknown")), collapsible: true },
      { title: "Days not listed", rows: sortRows(undated, (r) => r.s.start ?? 9999), collapsible: true },
    ];
  }

  /* ---------- rendering: day tabs, summary, banner ---------- */

  function renderDays() {
    $("#day-tabs").innerHTML = HH.DAYS.map((d, i) => `
      <button class="day ${i === state.day ? "is-selected" : ""}" role="tab"
        aria-selected="${i === state.day}" data-day="${i}">
        <span class="day-name">${d}</span>
        ${i === state.now.day ? '<span class="day-today">Today</span>' : ""}
      </button>`).join("");
  }

  function renderSummary(groups) {
    const count = (title) => (groups.find((g) => g.title === title) || { rows: [] }).rows.length;
    let text;
    if (state.day === state.now.day) {
      const now = count("On now"), soon = count("Starting soon"), later = count("Later today");
      text = `${now} on now · ${soon + later} later today`;
    } else {
      text = `${groups[0].rows.length} happy hours on ${HH.DAY_NAMES[state.day]}`;
    }
    $("#summary").textContent = text;
    const active = activeFilterCount();
    $("#filter-count").textContent = active;
    $("#filter-count").hidden = !active;
  }

  function renderBanner(error) {
    const el = $("#banner");
    if (state.source === "sheet") { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = error
      ? `<strong>Couldn't load your Google Sheet</strong>, so this is sample data. ${esc(error)}`
      : `<strong>Showing sample data.</strong> Connect your Google Sheet in <code>js/config.js</code>.`;
  }

  /* ---------- rendering: list ---------- */

  function badge(text, cls = "") { return `<span class="badge ${cls}">${esc(text)}</span>`; }

  function cardHtml({ s, st }) {
    const spot = s.spot;
    const meta = [spot.neighborhood, spot.type, spot.price].filter(Boolean).map(esc).join(" · ");
    const badges = [];
    if (s.label && !/^happy hour$/i.test(s.label)) badges.push(badge(s.label, "badge-label"));
    if (isBarOnly(s.seating)) badges.push(badge(s.seating, "badge-seat"));
    if (/late night/i.test(s.kind)) badges.push(badge("Late night", "badge-late"));
    if (!s.daysConfirmed) badges.push(badge("Days unconfirmed", "badge-warn"));

    const LIMIT = 4;
    const open = state.expanded.has(s.id);
    const deals = open ? s.deals : s.deals.slice(0, LIMIT);
    const dealsHtml = s.deals.length
      ? `<ul class="deals">${deals.map((d) => {
          const f = HH.formatDeal(d);
          return `<li><span class="deal-lead">${esc(f.lead)}</span> <span class="deal-item">${esc(f.item)}</span>${
            f.notes ? ` <span class="deal-note">${esc(f.notes)}</span>` : ""}</li>`;
        }).join("")}</ul>
        ${s.deals.length > LIMIT ? `<button class="more" data-expand="${esc(s.id)}">${
          open ? "Show less" : `+${s.deals.length - LIMIT} more`}</button>` : ""}`
      : `<p class="muted">Deals not listed yet.</p>`;

    const links = [
      directionsUrl(spot) && `<a href="${esc(directionsUrl(spot))}" target="_blank" rel="noopener">Directions</a>`,
      safeUrl(spot.website) && `<a href="${esc(safeUrl(spot.website))}" target="_blank" rel="noopener">Website</a>`,
      safeUrl(spot.yelpUrl) && `<a href="${esc(safeUrl(spot.yelpUrl))}" target="_blank" rel="noopener">Yelp</a>`,
      telUrl(spot.phone) && `<a href="${esc(telUrl(spot.phone))}">Call</a>`,
    ].filter(Boolean).join("");

    const verified = spot.lastVerified
      ? `Verified ${spot.lastVerified.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : "Not verified yet";
    const fine = [verified, spot.notes, s.notes, s.timeNote && !/all day|opening|close/i.test(s.timeNote) ? s.timeNote : ""]
      .filter(Boolean).map(esc).join(" · ");

    return `
      <article class="card state-${st.state}">
        <div class="card-top">
          <div class="card-title">
            <h3>${esc(spot.name)}</h3>
            ${meta ? `<p class="meta">${meta}</p>` : ""}
          </div>
          ${st.label ? `<span class="pill pill-${st.state}">${esc(st.label)}</span>` : ""}
        </div>
        <div class="when"><span class="time">${esc(HH.formatWindow(s))}</span>${badges.join("")}</div>
        ${dealsHtml}
        ${links ? `<div class="actions">${links}</div>` : ""}
        <p class="fine">${fine}</p>
      </article>`;
  }

  function renderList(groups) {
    const visible = groups.filter((g) => g.rows.length);
    if (!visible.length) {
      $("#list-view").innerHTML = `
        <div class="empty">
          <p><strong>No happy hours match.</strong></p>
          <p>Try another day or <button class="link" data-action="reset-filters">clear your filters</button>.</p>
        </div>`;
      return;
    }
    $("#list-view").innerHTML = visible.map((g) => {
      const cards = g.rows.map(cardHtml).join("");
      const heading = `${esc(g.title)} <span class="count">${g.rows.length}</span>`;
      return g.collapsible
        ? `<details class="group ${g.dim ? "is-dim" : ""}"><summary>${heading}</summary><div class="cards">${cards}</div></details>`
        : `<section class="group tone-${g.tone || "none"}"><h2>${heading}</h2><div class="cards">${cards}</div></section>`;
    }).join("");
  }

  /* ---------- rendering: map (Leaflet + OpenStreetMap, no API key) ---------- */

  let map = null;
  let markerLayer = null;
  const STATE_RANK = { now: 0, soon: 1, later: 2, scheduled: 2, unknown: 3, ended: 4 };

  function renderMap(groups) {
    const note = $("#map-note");
    if (!window.L) {
      note.textContent = "The map couldn't load (no internet connection, or the map library was blocked).";
      return;
    }
    if (!map) {
      map = L.map("map", { zoomControl: true }).setView(config.MAP_CENTER, config.MAP_ZOOM);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);
      markerLayer = L.layerGroup().addTo(map);
    }
    setTimeout(() => map.invalidateSize(), 0);
    markerLayer.clearLayers();

    // One marker per spot; colour = its "best" status that day.
    const bySpot = new Map();
    groups.filter((g) => g.title !== "Days not listed").forEach((g) => g.rows.forEach((r) => {
      const list = bySpot.get(r.s.spot.id) || [];
      list.push(r);
      bySpot.set(r.s.spot.id, list);
    }));

    const seen = new Map(); // nudge spots that share an address so both pins are tappable
    let missing = 0;
    bySpot.forEach((rows) => {
      const spot = rows[0].s.spot;
      if (!spot.hasCoords) { missing++; return; }
      rows.sort((a, b) => STATE_RANK[a.st.state] - STATE_RANK[b.st.state]);
      const key = `${spot.lat},${spot.lng}`;
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      const lat = spot.lat + n * 0.00012;
      const best = rows[0].st.state;
      const icon = L.divIcon({ className: "", html: `<span class="pin pin-${best}"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
      const lines = rows.map(({ s, st }) => {
        const top = s.deals.slice(0, 3).map((d) => { const f = HH.formatDeal(d); return `${esc(f.lead)} ${esc(f.item)}`; }).join("<br>");
        return `<div class="pop-row"><strong>${esc(HH.formatWindow(s))}</strong>${
          s.label && !/^happy hour$/i.test(s.label) ? ` · ${esc(s.label)}` : ""}${
          st.label ? `<br><span class="pop-status pop-${st.state}">${esc(st.label)}</span>` : ""}${
          top ? `<div class="pop-deals">${top}</div>` : ""}</div>`;
      }).join("");
      const dir = directionsUrl(spot);
      L.marker([lat, spot.lng], { icon, title: spot.name })
        .bindPopup(`<div class="pop"><div class="pop-name">${esc(spot.name)}</div>${lines}${
          dir ? `<a href="${esc(dir)}" target="_blank" rel="noopener">Directions</a>` : ""}</div>`)
        .addTo(markerLayer);
    });
    note.textContent = missing ? `${missing} spot(s) aren't on the map yet: add Latitude and Longitude in the Spots tab.` : "";
  }

  /* ---------- filters dialog ---------- */

  function activeFilterCount() {
    const f = state.filters;
    return (f.neighborhoods.length ? 1 : 0) + (f.prices.length ? 1 : 0) + (f.deals !== "any" ? 1 : 0) +
      (f.hideBarOnly ? 1 : 0) + (f.showSpecials ? 0 : 1);
  }

  function chip(group, value, label, on) {
    return `<button type="button" class="chip ${on ? "is-on" : ""}" aria-pressed="${on}"
      data-group="${group}" data-value="${esc(value)}">${esc(label)}</button>`;
  }

  function renderFilters() {
    const f = state.filters;
    const hoods = [...new Set([...state.model.spots.values()].map((s) => s.neighborhood).filter(Boolean))].sort();
    const prices = ["$", "$$", "$$$", "$$$$"];
    $("#filters-body").innerHTML = `
      <fieldset><legend>Neighborhood</legend><div class="chips">
        ${hoods.map((h) => chip("neighborhoods", h, h, f.neighborhoods.includes(h))).join("")}</div></fieldset>
      <fieldset><legend>Price</legend><div class="chips">
        ${prices.map((p) => chip("prices", p, p, f.prices.includes(p))).join("")}</div>
        <p class="hint">Spots without a price category are hidden while a price is selected.</p></fieldset>
      <fieldset><legend>Deals</legend><div class="chips">
        ${chip("deals", "any", "Any", f.deals === "any")}
        ${chip("deals", "food", "Has food deals", f.deals === "food")}
        ${chip("deals", "drinks", "Drinks only", f.deals === "drinks")}</div></fieldset>
      <fieldset><legend>Seating & extras</legend><div class="chips">
        ${chip("hideBarOnly", "toggle", "Need a table (hide bar-only)", f.hideBarOnly)}
        ${chip("showSpecials", "toggle", "Include day specials & events", f.showSpecials)}</div></fieldset>`;
  }

  function onFilterChip(btn) {
    const { group, value } = btn.dataset;
    const f = state.filters;
    if (group === "neighborhoods" || group === "prices") {
      f[group] = f[group].includes(value) ? f[group].filter((v) => v !== value) : [...f[group], value];
    } else if (group === "deals") {
      f.deals = value;
    } else {
      f[group] = !f[group];
    }
    savePrefs();
    renderFilters();
    render();
  }

  /* ---------- footer ---------- */

  function renderFooter() {
    const spots = [...state.model.spots.values()];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const fresh = spots.filter((s) => s.lastVerified && s.lastVerified.getTime() >= cutoff).length;
    const pct = spots.length ? Math.round((fresh / spots.length) * 100) : 0;
    $("#footer").innerHTML = `
      <p>${spots.length} spots · ${pct}% verified in the last 30 days</p>
      <p>Times are San Diego time. Deals change, so check with the spot before you go.</p>`;
  }

  /* ---------- main render ---------- */

  function render() {
    state.now = HH.nowIn(config.TIME_ZONE);
    const groups = groupsForDay();
    renderDays();
    renderSummary(groups);
    document.querySelectorAll("[data-view]").forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-selected", String(on));
    });
    $("#list-view").hidden = state.view !== "list";
    $("#map-view").hidden = state.view !== "map";
    if (state.view === "list") renderList(groups);
    else renderMap(groups);
  }

  /* ---------- events ---------- */

  function wireEvents() {
    $("#day-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day]");
      if (!btn) return;
      state.day = Number(btn.dataset.day);
      render();
    });
    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
      state.view = b.dataset.view;
      savePrefs();
      render();
    }));
    $("#list-view").addEventListener("click", (e) => {
      const more = e.target.closest("[data-expand]");
      if (more) {
        const id = more.dataset.expand;
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        render();
      }
      if (e.target.closest('[data-action="reset-filters"]')) resetFilters();
    });

    const dialog = $("#filters-dialog");
    $("#filters-btn").addEventListener("click", () => {
      renderFilters();
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    });
    $("#filters-body").addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (btn) onFilterChip(btn);
    });
    $("#filters-reset").addEventListener("click", () => { resetFilters(); renderFilters(); });
    $("#filters-done").addEventListener("click", () => (dialog.close ? dialog.close() : dialog.removeAttribute("open")));
    dialog.addEventListener("click", (e) => { if (e.target === dialog && dialog.close) dialog.close(); }); // tap backdrop
  }

  function resetFilters() {
    state.filters = { ...DEFAULT_FILTERS };
    savePrefs();
    render();
  }

  /* ---------- start ---------- */

  async function start() {
    document.title = config.APP_TITLE;
    $("#app-title").textContent = config.APP_TITLE;
    $("#app-subtitle").textContent = config.APP_SUBTITLE;
    loadPrefs();
    wireEvents();
    try {
      const { model, source, error } = await HH.loadData(config);
      state.model = model;
      state.source = source;
      renderBanner(error);
      renderFooter();
      render();
      // Refresh "On now · 20 min left" labels each minute (list only, so open map popups stay put).
      setInterval(() => { if (state.view === "list") render(); }, 60 * 1000);
    } catch (e) {
      $("#list-view").innerHTML = `<div class="empty"><p><strong>Couldn't load happy hours.</strong></p><p>${esc(e.message || e)}</p></div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", start);
})();
