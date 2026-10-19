/*
 * app.js — everything you see on the page: week strip, search, filters sheet, the list, and the map.
 * Data loading and status logic live in data.js; this file only reads the model it builds.
 *
 * Flow: start() → HH.loadData() → render() whenever the day, view, search or filters change
 * (and once a minute, so "Ends in 20 min" stays current).
 */
(function () {
  const config = window.HH_CONFIG;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------- icons (simple inline SVG line icons) ---------- */

  const ICON = {
    clock: '<svg class="clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    directions: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l9.2 9.2-9.2 9.2L2.8 12z"/><path d="M9 14v-2.5a1.5 1.5 0 011.5-1.5H15"/><path d="M13 8l2 2-2 2"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 006.6 6.6l1.3-2 4 1.4v2.6a2 2 0 01-2.1 2A16.5 16.5 0 014.6 5.6a2 2 0 012-2.1z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.4 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.4-3.5-8.5s1.1-6.1 3.5-8.5z"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    check: '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
    glass: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14l-7 8z"/><path d="M12 12v7M8 20h8"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    leaf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19l7-7"/></svg>',
  };

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
    search: "",
    filters: { ...DEFAULT_FILTERS },
    expanded: new Set(), // schedule IDs whose full deal list is open
    dietOpen: new Set(), // spot IDs whose dietary list is open
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
  const isPlainLabel = (label) => !label || /^happy hour$/i.test(label);

  /** Calendar dates (local Date objects) for Mon–Sun of the current San Diego week. */
  function weekDates() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.TIME_ZONE, year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const today = new Date(get("year"), get("month") - 1, get("day"));
    return HH.DAYS.map((_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - state.now.day + i);
      return d;
    });
  }

  /* ---------- filtering + grouping ---------- */

  function matchesSearch(s) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    const hay = [s.spot.name, s.spot.neighborhood, s.spot.type, s.label, ...s.deals.map((d) => d.item)]
      .join(" ").toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  }

  function passesFilters(s) {
    const f = state.filters;
    if (f.neighborhoods.length && !f.neighborhoods.includes(s.spot.neighborhood)) return false;
    if (f.prices.length && !f.prices.includes(s.spot.price)) return false;
    if (f.deals === "food" && !s.hasFood) return false;
    if (f.deals === "drinks" && (s.hasFood || !s.deals.length)) return false;
    if (f.hideBarOnly && isBarOnly(s.seating)) return false;
    if (!f.showSpecials && isSpecial(s)) return false;
    return matchesSearch(s);
  }

  /** Schedules for the selected day, with status, split into display sections. */
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
        { id: "now", title: "On Now", rows: sortRows(byState("now")), tone: "now" },
        { id: "soon", title: "Starting Soon", rows: sortRows(byState("soon")) },
        { id: "later", title: "Later Today", rows: sortRows(byState("later")) },
        { id: "unknown", title: "Hours Not Listed", rows: sortRows(byState("unknown")), collapsible: true },
        { id: "ended", title: "Ended Earlier", rows: sortRows(byState("ended")), collapsible: true, dim: true },
        { id: "undated", title: "Days Not Listed", rows: sortRows(undated, (r) => r.s.start ?? 9999), collapsible: true },
      ];
    }
    return [
      { id: "day", title: HH.DAY_NAMES[state.day], rows: sortRows(byState("scheduled")) },
      { id: "unknown", title: "Hours Not Listed", rows: sortRows(byState("unknown")), collapsible: true },
      { id: "undated", title: "Days Not Listed", rows: sortRows(undated, (r) => r.s.start ?? 9999), collapsible: true },
    ];
  }

  /* ---------- header: eyebrow date, week strip, summary, banner ---------- */

  function renderHeader(groups) {
    const dates = weekDates();
    const selected = dates[state.day];
    const dateText = selected.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    $("#eyebrow").textContent = state.day === state.now.day ? `Today · ${dateText}` : dateText;

    const anyNow = state.model.schedules.some((s) => s.hasDays && s.days[state.now.day] &&
      HH.statusFor(s, state.now.day, state.now, config).state === "now");
    $("#week").innerHTML = HH.DAYS.map((d, i) => {
      const cls = ["day", i === state.day && "is-selected", i === state.now.day && "is-today",
        i === state.now.day && anyNow && "has-now"].filter(Boolean).join(" ");
      const label = `${HH.DAY_NAMES[i]}, ${dates[i].toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
      return `<button type="button" class="${cls}" role="tab" aria-selected="${i === state.day}"
        aria-label="${esc(label)}" data-day="${i}">
        <span class="day-letter">${d.slice(0, 1)}</span>
        <span class="day-num">${dates[i].getDate()}</span>
        <span class="day-dot"></span>
      </button>`;
    }).join("");

    const count = (id) => (groups.find((g) => g.id === id) || { rows: [] }).rows.length;
    let html;
    if (state.day === state.now.day) {
      const now = count("now");
      const later = count("soon") + count("later");
      html = `${now ? `<b>${now} on now</b>` : "Nothing on right now"} · ${later} later today`;
    } else {
      const n = count("day");
      html = `${n} happy hour${n === 1 ? "" : "s"} on ${HH.DAY_NAMES[state.day]}`;
    }
    if (state.search.trim()) html += ` · matching “${esc(state.search.trim())}”`;
    $("#summary").innerHTML = html;

    const active = activeFilterCount();
    $("#filter-count").textContent = active;
    $("#filter-count").hidden = !active;
    $$("#filters-btn, #filters-btn-compact").forEach((b) => b.classList.toggle("is-active", active > 0));
  }

  function renderBanner(error) {
    const el = $("#banner");
    if (state.source === "sheet") { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = error
      ? `<strong>Showing sample data.</strong> Couldn't load your Google Sheet: ${esc(error)}`
      : `<strong>Showing sample data.</strong> Connect your Google Sheet in <code>js/config.js</code>.`;
  }

  /* ---------- list ---------- */

  function statusPill(st) {
    if (!st.label) return "";
    const dot = st.state === "now" ? '<span class="dot dot-now"></span>' : "";
    return `<span class="status status-${st.state}">${dot}${esc(st.label)}</span>`;
  }

  function cardHtml({ s, st }) {
    const spot = s.spot;
    const sub = [spot.neighborhood, spot.type, spot.price].filter(Boolean).map(esc).join(" · ");

    const tags = [];
    if (!isPlainLabel(s.label)) tags.push(`<span class="tag tag-special">${esc(s.label)}</span>`);
    if (/late night/i.test(s.kind)) tags.push('<span class="tag tag-late">Late Night</span>');
    if (isBarOnly(s.seating)) tags.push(`<span class="tag">${esc(s.seating)}</span>`);
    if (!s.daysConfirmed) tags.push('<span class="tag tag-warn">Days unconfirmed</span>');

    const LIMIT = 3;
    const open = state.expanded.has(s.id);
    const shown = open ? s.deals : s.deals.slice(0, LIMIT);
    const deals = s.deals.length
      ? `<ul class="deals">${shown.map((d) => {
          const f = HH.formatDeal(d);
          return `<li><span class="deal-item">${esc(f.item)}${f.notes ? `<span class="deal-note">${esc(f.notes)}</span>` : ""}</span>
            <span class="deal-price">${esc(f.lead)}</span></li>`;
        }).join("")}</ul>${s.deals.length > LIMIT ? `<button type="button" class="show-all" data-expand="${esc(s.id)}">${
          open ? "Show Less" : `Show All ${s.deals.length} Deals`}</button>` : ""}`
      : '<p class="no-deals">Deals not listed yet.</p>';

    const actions = [
      directionsUrl(spot) && `<a class="action primary" href="${esc(directionsUrl(spot))}" target="_blank" rel="noopener">${ICON.directions}Directions</a>`,
      spot.menuPhoto && `<button type="button" class="action" data-photo="${esc(spot.id)}">${ICON.menu}Menu</button>`,
      telUrl(spot.phone) && `<a class="action" href="${esc(telUrl(spot.phone))}">${ICON.phone}Call</a>`,
      safeUrl(spot.website) && `<a class="action" href="${esc(safeUrl(spot.website))}" target="_blank" rel="noopener">${ICON.globe}Website</a>`,
      safeUrl(spot.yelpUrl) && `<a class="action" href="${esc(safeUrl(spot.yelpUrl))}" target="_blank" rel="noopener">${ICON.star}Yelp</a>`,
    ].filter(Boolean).join("");

    const verified = spot.lastVerified
      ? `Verified ${spot.lastVerified.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : "Not verified yet";
    const extraNote = s.timeNote && !/all day|opening|close|hours not listed|days unknown/i.test(s.timeNote) ? s.timeNote : "";
    const foot = [verified, spot.notes, s.notes, extraNote].filter(Boolean).map(esc).join(" · ");

    return `
      <article class="card">
        <div class="card-head">
          <div>
            <h3>${esc(spot.name)}</h3>
            ${sub ? `<p class="sub">${sub}</p>` : ""}
          </div>
          ${statusPill(st)}
        </div>
        <div class="when">${ICON.clock}<span class="time">${esc(HH.formatWindow(s))}</span>${tags.join("")}</div>
        ${deals}
        ${dietaryHtml(spot)}
        ${actions ? `<div class="actions">${actions}</div>` : ""}
        <p class="footnote">${foot}${config.MENU_UPLOAD_URL
          ? ` <button type="button" class="inline-link" data-upload="${esc(spot.id)}">${ICON.camera}Upload menu photo</button>` : ""}</p>
      </article>`;
  }

  /** Dietary tags read from approved menu photos: tag chips, tap to see the items. */
  function dietaryHtml(spot) {
    if (!spot.dietaryItems.length) return "";
    const counts = {};
    spot.dietaryItems.forEach((it) => it.dietary.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    const open = state.dietOpen.has(spot.id);
    const chips = Object.keys(counts).sort().map((t) =>
      `<span class="diet-chip">${esc(t)} <b>${counts[t]}</b></span>`).join("");
    const list = open ? `<ul class="diet-list">${spot.dietaryItems.map((it) => {
      const price = it.price !== null ? `$${Number.isInteger(it.price) ? it.price : it.price.toFixed(2)}` : it.priceText;
      return `<li><span class="deal-item">${esc(it.name)}${it.happyHour ? ' <span class="tag tag-special">HH</span>' : ""}
          ${it.description ? `<span class="deal-note">${esc(it.description)}</span>` : ""}
          <span class="diet-tags">${it.dietary.map(esc).join(" · ")}</span></span>
        <span class="deal-price">${esc(price || "")}</span></li>`;
    }).join("")}</ul>` : "";
    return `<div class="diet">
      <button type="button" class="diet-head" data-diet="${esc(spot.id)}" aria-expanded="${open}">
        ${ICON.leaf}<span class="diet-chips">${chips}</span>${ICON.chevron}
      </button>${list}
      ${open ? '<p class="deal-note">Read from the menu photo. Always confirm allergies with staff.</p>' : ""}
    </div>`;
  }

  function emptyHtml() {
    const q = state.search.trim();
    if (q) {
      return `<div class="empty">${ICON.search}<h3>No Results for “${esc(q)}”</h3>
        <p>Check the spelling or try a new search.</p></div>`;
    }
    return `<div class="empty">${ICON.glass}<h3>No Happy Hours</h3>
      <p>Try another day${activeFilterCount() ? ' or <button type="button" class="text-btn" data-action="reset-filters">clear your filters</button>' : ""}.</p></div>`;
  }

  function renderList(groups) {
    const visible = groups.filter((g) => g.rows.length);
    if (!visible.length) { $("#list-view").innerHTML = emptyHtml(); return; }
    $("#list-view").innerHTML = visible.map((g) => {
      const cards = `<div class="cards">${g.rows.map(cardHtml).join("")}</div>`;
      if (g.collapsible) {
        return `<details class="section ${g.dim ? "is-dim" : ""}" data-section="${g.id}">
          <summary><span>${esc(g.title)}<span class="count">${g.rows.length}</span></span>${ICON.chevron}</summary>${cards}</details>`;
      }
      return `<section class="section tone-${g.tone || "none"}">
        <h2 class="section-head">${esc(g.title)}<span class="count">${g.rows.length}</span></h2>${cards}</section>`;
    }).join("");
    // keep disclosure sections open across re-renders
    $$("details[data-section]").forEach((d) => {
      if (openSections.has(d.dataset.section)) d.open = true;
      d.addEventListener("toggle", () => { d.open ? openSections.add(d.dataset.section) : openSections.delete(d.dataset.section); });
    });
  }
  const openSections = new Set();

  /* ---------- map (Leaflet + OpenStreetMap tiles; set in config.MAP_TILES) ---------- */

  let map = null;
  let markerLayer = null;
  let tileLayer = null;
  let meMarker = null;
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const STATE_RANK = { now: 0, soon: 1, later: 2, scheduled: 2, unknown: 3, ended: 4 };

  function setTiles() {
    if (!map) return;
    // Dark mode = the same tiles, dimmed and inverted with CSS (.map.is-dark in styles.css).
    $("#map").classList.toggle("is-dark", Boolean(darkQuery && darkQuery.matches));
    if (tileLayer) return;
    const tiles = config.MAP_TILES || {};
    tileLayer = L.tileLayer(tiles.url || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: tiles.maxZoom || 19,
      attribution: tiles.attribution || "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }

  function renderMap(groups) {
    const note = $("#map-note");
    if (!window.L) {
      note.textContent = "The map couldn't load. Check your internet connection.";
      return;
    }
    if (!map) {
      map = L.map("map", { zoomControl: true, attributionControl: true }).setView(config.MAP_CENTER, config.MAP_ZOOM);
      map.zoomControl.setPosition("bottomright");
      setTiles();
      if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", setTiles);
      markerLayer = L.layerGroup().addTo(map);
    }
    setTimeout(() => map.invalidateSize(), 0);
    markerLayer.clearLayers();

    // One marker per spot; colour = its "best" status that day.
    const bySpot = new Map();
    groups.filter((g) => g.id !== "undated").forEach((g) => g.rows.forEach((r) => {
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
      const best = rows[0].st.state;
      const icon = L.divIcon({ className: "", html: `<span class="pin pin-${best}"></span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
      const body = rows.map(({ s, st }) => {
        const top = s.deals.slice(0, 3).map((d) => { const f = HH.formatDeal(d); return `${esc(f.item)} ${esc(f.lead)}`; }).join(" · ");
        return `<div class="pop-row"><span class="pop-time">${esc(HH.formatWindow(s))}</span>${
          !isPlainLabel(s.label) ? ` · ${esc(s.label)}` : ""}${
          st.label ? `<br><span class="pop-status">${statusPill(st)}</span>` : ""}${
          top ? `<div class="pop-deals">${top}</div>` : ""}</div>`;
      }).join("");
      const dir = directionsUrl(spot);
      const sub = [spot.neighborhood, spot.price].filter(Boolean).map(esc).join(" · ");
      L.marker([spot.lat + n * 0.00012, spot.lng], { icon, title: spot.name, riseOnHover: true })
        .bindPopup(`<p class="pop-name">${esc(spot.name)}</p>${sub ? `<p class="pop-sub">${sub}</p>` : ""}${body}${
          dir ? `<a class="pop-btn" href="${esc(dir)}" target="_blank" rel="noopener">Directions</a>` : ""}`,
          { maxWidth: 280, autoPanPadding: [24, 24] })
        .addTo(markerLayer);
    });
    note.textContent = missing ? `${missing} spot(s) aren't on the map yet: add Latitude and Longitude in the Spots tab.` : "";
  }

  function locateMe() {
    if (!map || !navigator.geolocation) return;
    const btn = $("#locate-btn");
    btn.classList.add("is-on");
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.marker(ll, {
        icon: L.divIcon({ className: "", html: '<span class="me-dot"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false, keyboard: false,
      }).addTo(map);
      map.flyTo(ll, Math.max(map.getZoom(), 16), { duration: 0.8 });
    }, () => {
      btn.classList.remove("is-on");
      $("#map-note").textContent = "Couldn't get your location. Check that location access is allowed for this site.";
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  /* ---------- filters sheet ---------- */

  function activeFilterCount() {
    const f = state.filters;
    return (f.neighborhoods.length ? 1 : 0) + (f.prices.length ? 1 : 0) + (f.deals !== "any" ? 1 : 0) +
      (f.hideBarOnly ? 1 : 0) + (f.showSpecials ? 0 : 1);
  }

  function seg(group, value, label, on) {
    return `<button type="button" aria-pressed="${on}" data-group="${group}" data-value="${esc(value)}">${esc(label)}</button>`;
  }
  function switchRow(key, title, hint, on) {
    return `<label class="row"><span class="row-text">${esc(title)}${hint ? `<small>${esc(hint)}</small>` : ""}</span>
      <span class="switch"><input type="checkbox" role="switch" data-toggle="${key}" ${on ? "checked" : ""}><span class="track"></span></span></label>`;
  }
  function checkRow(group, value, label, on) {
    return `<button type="button" class="row" role="menuitemcheckbox" aria-checked="${on}" data-group="${group}" data-value="${esc(value)}">
      <span>${esc(label)}</span>${ICON.check}</button>`;
  }

  function renderFilters() {
    const f = state.filters;
    const hoods = [...new Set([...state.model.spots.values()].map((s) => s.neighborhood).filter(Boolean))].sort();
    $("#filters-body").innerHTML = `
      <p class="group-label">Deals</p>
      <div class="segmented" role="group" aria-label="Deals">
        ${seg("deals", "any", "All", f.deals === "any")}
        ${seg("deals", "food", "Food Deals", f.deals === "food")}
        ${seg("deals", "drinks", "Drinks Only", f.deals === "drinks")}
      </div>

      <p class="group-label">Price</p>
      <div class="segmented" role="group" aria-label="Price">
        ${["$", "$$", "$$$", "$$$$"].map((p) => seg("prices", p, p, f.prices.includes(p))).join("")}
      </div>
      <p class="group-foot">Choose one or more. Spots without a price are hidden while a price is selected.</p>

      <p class="group-label">Seating & Specials</p>
      <div class="group">
        ${switchRow("hideBarOnly", "Need a Table", "Hide spots where happy hour is bar-only", f.hideBarOnly)}
        ${switchRow("showSpecials", "Day Specials & Events", "Taco Tuesday, wine nights, game days", f.showSpecials)}
      </div>

      <p class="group-label">Neighborhood</p>
      <div class="group">
        ${checkRow("neighborhoods", "", "All Neighborhoods", !f.neighborhoods.length)}
        ${hoods.map((h) => checkRow("neighborhoods", h, h, f.neighborhoods.includes(h))).join("")}
      </div>`;
  }

  function onFilterButton(btn) {
    const { group, value } = btn.dataset;
    const f = state.filters;
    if (group === "neighborhoods" && value === "") f.neighborhoods = [];
    else if (group === "neighborhoods" || group === "prices") {
      f[group] = f[group].includes(value) ? f[group].filter((v) => v !== value) : [...f[group], value];
    } else if (group === "deals") f.deals = value;
    afterFilterChange();
  }
  function afterFilterChange() {
    savePrefs();
    const body = $("#filters-body");
    const scroll = body.scrollTop;
    renderFilters();
    body.scrollTop = scroll;
    render();
  }
  function resetFilters() {
    state.filters = { ...DEFAULT_FILTERS };
    savePrefs();
    render();
  }

  /* ---------- menu photo viewer ---------- */

  function openPhoto(spotId) {
    const spot = state.model.spots.get(spotId);
    if (!spot || !spot.menuPhoto) return;
    const p = spot.menuPhoto;
    const dlg = $("#photo-dialog");
    $("#photo-title").textContent = spot.name;
    $("#photo-date").textContent = p.submitted
      ? `Menu photo · ${p.submitted.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "Menu photo";
    const img = $("#photo-img");
    img.hidden = !p.imageUrl;
    img.src = p.imageUrl || "";
    img.alt = `Menu at ${spot.name}`;
    const link = $("#photo-open");
    link.href = safeUrl(p.photoUrl) || p.imageUrl;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  }

  /* ---------- menu photo upload (sends to google-apps-script/menu-upload.gs) ---------- */

  const upload = { spotId: null, image: null, busy: false };

  function openUpload(spotId) {
    const spot = state.model.spots.get(spotId);
    if (!spot || !config.MENU_UPLOAD_URL) return;
    upload.spotId = spotId;
    upload.image = null;
    renderUploadForm(spot);
    const dlg = $("#upload-dialog");
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  }

  function renderUploadForm(spot) {
    $("#upload-body").innerHTML = `
      <p class="upload-spot">${esc(spot.name)}</p>
      <label class="photo-pick">
        <input type="file" id="upload-file" accept="image/*">
        <img id="upload-preview" alt="" hidden>
        <span class="photo-pick-empty" id="upload-empty">${ICON.camera}<span>Take or choose a photo of the happy hour menu</span></span>
      </label>
      <p class="group-label">Note (optional)</p>
      <div class="group"><textarea id="upload-note" class="note" rows="2" maxlength="500"
        placeholder="e.g. new menu as of this week"></textarea></div>
      <input type="text" id="upload-website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="button" id="upload-submit" class="btn-primary" disabled>Upload Photo</button>
      <p class="group-foot">We read the days, hours, deals, prices and dietary labels automatically.
        Photos are reviewed before they appear in the app.</p>`;
  }

  /** Shrink the photo (long edge 2000px, JPEG) so uploads are quick on cell data. */
  async function prepareImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("That file doesn't look like a photo."));
        i.src = url;
      });
      const MAX = 2000;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      return { dataUrl, base64: dataUrl.split(",")[1], mimeType: "image/jpeg" };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function submitUpload() {
    if (upload.busy || !upload.image) return;
    upload.busy = true;
    const spot = state.model.spots.get(upload.spotId);
    const payload = {
      spotId: upload.spotId,
      image: upload.image.base64,
      mimeType: upload.image.mimeType,
      note: ($("#upload-note") || {}).value || "",
      website: ($("#upload-website") || {}).value || "", // honeypot: bots fill this in
    };
    $("#upload-body").innerHTML = `<div class="loading"><span class="spinner"></span>Reading the menu… this can take up to 30 seconds.</div>`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      // No custom headers → a "simple" request, which Apps Script web apps accept cross-origin.
      const res = await fetch(config.MENU_UPLOAD_URL, { method: "POST", body: JSON.stringify(payload), signal: ctrl.signal });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Upload failed.");
      renderUploadResult(spot, data);
    } catch (e) {
      $("#upload-body").innerHTML = `<div class="empty">${ICON.camera}<h3>Couldn't Upload</h3>
        <p>${esc(e.name === "AbortError" ? "It took too long. Please try again." : e.message || e)}</p></div>
        <button type="button" class="btn-primary" data-retry>Try Again</button>`;
    } finally {
      clearTimeout(timer);
      upload.busy = false;
    }
  }

  function renderUploadResult(spot, data) {
    const s = data.summary;
    const rows = [];
    if (s) {
      if (!s.isMenu) rows.push(["Heads up", "This might not be a menu, but we'll take a look."]);
      const when = [s.days.join(", "), [s.start, s.end].filter(Boolean).join("–")].filter(Boolean).join(" · ");
      if (when) rows.push(["Happy hour", when]);
      if (s.details) rows.push(["Details", s.details]);
      if (s.deals.length) rows.push(["Deals", s.deals.join("; ")]);
      rows.push(["Menu items", String(s.itemCount)]);
      const diet = Object.keys(s.dietary || {}).map((k) => `${k} ${s.dietary[k]}`).join(" · ");
      if (diet) rows.push(["Dietary", diet]);
    }
    $("#upload-body").innerHTML = `
      <div class="upload-done">${ICON.check}<h3>Thanks!</h3>
        <p>Your photo of ${esc(spot.name)}'s menu was sent for review.</p></div>
      ${rows.length ? `<p class="group-label">What we read</p><div class="group">${rows.map(([k, v]) =>
        `<div class="row"><span class="row-text">${esc(k)}<small>${esc(v)}</small></span></div>`).join("")}</div>`
        : `<p class="group-foot">${esc(data.aiError ? "We couldn't read it automatically, but we'll review it by hand." : "")}</p>`}
      <button type="button" class="btn-primary" data-close-upload>Done</button>`;
  }

  function wireMenuDialogs() {
    const photoDlg = $("#photo-dialog");
    $("#photo-close").addEventListener("click", () => photoDlg.close ? photoDlg.close() : photoDlg.removeAttribute("open"));
    photoDlg.addEventListener("click", (e) => { if (e.target === photoDlg && photoDlg.close) photoDlg.close(); });

    const dlg = $("#upload-dialog");
    const close = () => (dlg.close ? dlg.close() : dlg.removeAttribute("open"));
    $("#upload-cancel").addEventListener("click", close);
    dlg.addEventListener("click", (e) => { if (e.target === dlg && !upload.busy) close(); });
    $("#upload-body").addEventListener("change", async (e) => {
      if (e.target.id !== "upload-file" || !e.target.files[0]) return;
      try {
        upload.image = await prepareImage(e.target.files[0]);
        const prev = $("#upload-preview");
        prev.src = upload.image.dataUrl;
        prev.hidden = false;
        $("#upload-empty").hidden = true;
        $("#upload-submit").disabled = false;
      } catch (err) {
        upload.image = null;
        $("#upload-submit").disabled = true;
        alert(err.message || err);
      }
    });
    $("#upload-body").addEventListener("click", (e) => {
      if (e.target.closest("#upload-submit")) submitUpload();
      if (e.target.closest("[data-close-upload]")) close();
      if (e.target.closest("[data-retry]")) renderUploadForm(state.model.spots.get(upload.spotId));
    });
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
    renderHeader(groups);
    $$(".tab").forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-current", on ? "page" : "false");
    });
    $("#list-view").hidden = state.view !== "list";
    $("#map-view").hidden = state.view !== "map";
    $("#footer").hidden = state.view !== "list";
    if (state.view === "list") renderList(groups);
    else renderMap(groups);
  }

  /* ---------- events ---------- */

  function wireEvents() {
    $("#week").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day]");
      if (!btn) return;
      state.day = Number(btn.dataset.day);
      render();
    });

    $$(".tab").forEach((b) => b.addEventListener("click", () => {
      if (state.view === b.dataset.view) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      state.view = b.dataset.view;
      savePrefs();
      render();
    }));

    const search = $("#search");
    let t = null;
    search.addEventListener("input", () => {
      $("#search-clear").hidden = !search.value;
      clearTimeout(t);
      t = setTimeout(() => { state.search = search.value; render(); }, 120);
    });
    $("#search-clear").addEventListener("click", () => {
      search.value = ""; state.search = ""; $("#search-clear").hidden = true; render(); search.focus();
    });

    $("#list-view").addEventListener("click", (e) => {
      const more = e.target.closest("[data-expand]");
      if (more) {
        const id = more.dataset.expand;
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        render();
      }
      if (e.target.closest('[data-action="reset-filters"]')) resetFilters();
      const diet = e.target.closest("[data-diet]");
      if (diet) {
        const id = diet.dataset.diet;
        state.dietOpen.has(id) ? state.dietOpen.delete(id) : state.dietOpen.add(id);
        render();
      }
      const photo = e.target.closest("[data-photo]");
      if (photo) openPhoto(photo.dataset.photo);
      const up = e.target.closest("[data-upload]");
      if (up) openUpload(up.dataset.upload);
    });
    wireMenuDialogs();

    const dialog = $("#filters-dialog");
    const openFilters = () => {
      renderFilters();
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    };
    const closeFilters = () => (dialog.close ? dialog.close() : dialog.removeAttribute("open"));
    $("#filters-btn").addEventListener("click", openFilters);
    $("#filters-btn-compact").addEventListener("click", openFilters);
    $("#filters-done").addEventListener("click", closeFilters);
    $("#filters-reset").addEventListener("click", () => { resetFilters(); renderFilters(); });
    dialog.addEventListener("click", (e) => { if (e.target === dialog) closeFilters(); }); // tap the dimmed backdrop
    $("#filters-body").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-group]");
      if (btn) onFilterButton(btn);
    });
    $("#filters-body").addEventListener("change", (e) => {
      const key = e.target.dataset && e.target.dataset.toggle;
      if (!key) return;
      state.filters[key] = e.target.checked;
      afterFilterChange();
    });

    $("#locate-btn").addEventListener("click", locateMe);

    // Frosted compact bar appears once the large title scrolls away (like iOS navigation bars).
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        $("#sticky-bar").classList.toggle("is-stuck", !entry.isIntersecting);
      }, { threshold: 0 }).observe($("#large-title"));
    }
  }

  /* ---------- start ---------- */

  async function start() {
    document.title = config.APP_TITLE;
    loadPrefs();
    wireEvents();
    try {
      const { model, source, error } = await HH.loadData(config);
      state.model = model;
      state.source = source;
      renderBanner(error);
      renderFooter();
      render();
      // Refresh "Ends in 20 min" labels each minute (list only, so open map popups stay put).
      setInterval(() => { if (state.view === "list") render(); }, 60 * 1000);
    } catch (e) {
      $("#list-view").innerHTML = `<div class="empty">${ICON.glass}<h3>Couldn't Load Happy Hours</h3><p>${esc(e.message || e)}</p></div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", start);
})();
