/*
 * group.js — "Group Pick": the organizer starts a group and texts a link; each person says when
 * they can get there and what they'd like; the app recommends the spot that suits the group best.
 *
 * Rules (same as the design):
 *   - Arrival time is the one requirement: happy hour must run at least MIN_OVERLAP minutes after
 *     the last person gets there, and must have started by then (or within START_GRACE minutes).
 *   - Every other preference only ranks spots. Each person's preferences share one point, so a
 *     long list can't outvote a short one. Met = 1, unknown (data missing) = 0.5, missed = 0.
 *   - Ties: longer shared happy hour, then verified data, then name.
 *
 * Backend: google-apps-script/group-pick.gs (same web app as menu uploads). Ranking runs here,
 * against the same sheet data the main list uses. Phone-side identity: localStorage.
 */
(function () {
  const config = window.HH_CONFIG || {};
  const API_URL = config.GROUP_PICK_URL || config.MENU_UPLOAD_URL || "";
  const STORE_KEY = "hh-groups-v1";
  const MIN_OVERLAP = 45;
  const START_GRACE = 30;
  const POLL_MS = 20000;
  const ARRIVE_TIMES = [900, 930, 960, 990, 1020, 1050, 1080, 1110, 1140]; // 3:00–7:00 PM
  const PRICES = ["$", "$$", "$$$"];
  const DRINKS = ["Beer", "Wine", "Cocktails", "Non-alcoholic"];
  const VIBES = ["Dive bar", "Wine bar", "Brewpub", "Cocktail bar", "Restaurant", "Rooftop"];
  const FALLBACK_HOODS = ["Little Italy", "Gaslamp", "East Village", "Embarcadero", "Columbia", "Middletown"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WEEKDAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

  const DRINK_RE = {
    Beer: /beer|pint|draft|draught|\bipa\b|lager|pils|\bale\b|pitcher|brew|modelo|sapporo|stella|michelada/i,
    Wine: /wine|vino|prosecco|sangria|ros[eé]\b|champagne|cava|bubbles|spritz/i,
    Cocktails: /cocktail|margarita|\bmarg|martini|\bwell|mule|mojito|old fashioned|highball|spirit|negroni|paloma|mezcal|tequila|whiske?y|vodka|gin\b|sake/i,
    "Non-alcoholic": /mocktail|non-?alc|zero.proof|\bn\/a\b|soda|lemonade|kombucha|na beer/i,
  };
  const GENERIC_DRINKS = /drink|beverage|bar menu|alcohol|bar bites/i;
  const VIBE_RE = {
    "Dive bar": /dive/i,
    "Wine bar": /wine|enoteca|vino/i,
    Brewpub: /brew|pub|tap ?room|beer|tavern/i,
    "Cocktail bar": /cocktail|lounge|speakeasy|tiki|mezcal|whiske?y/i,
    Restaurant: /restaurant|kitchen|grill|steak|pizza|italian|seafood|oyster|taco|sushi|bistro|eatery|tapas|mexican|american|japanese|thai|chain|counter|trattoria|cantina/i,
    Rooftop: /rooftop|roof/i,
  };
  const isBarOnly = (seating) => /bar|counter|lounge/i.test(seating || "") && !/whole|patio/i.test(seating || "");

  const ICON = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17.5 14.2c2.4.4 4 2.4 4 5.3"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  };

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const $ = (sel, root = document) => root.querySelector(sel);
  const fmtTime = (m) => HH.formatTime(m);
  const list = (names) => names.length <= 1 ? (names[0] || "") :
    names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  /* ---------- state ---------- */

  const S = {
    view: null,         // "start" | "lobby" | "join" | "prefs" | "results" | "day"
    code: null,
    group: null,
    members: [],
    loading: false,
    error: "",
    busy: false,
    draft: null,        // preferences being edited
    startName: "",
    yourName: "",
    joinName: "",
    cal: null,          // { y, m, sel }
    model: null,
    modelPromise: null,
    modelError: "",
    copied: false,
    asked: {},
    poll: null,
  };

  /* ---------- phone-side identity ---------- */

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { groups: {}, name: "" }; }
    catch (e) { return { groups: {}, name: "" }; }
  }
  function writeStore(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* private mode: fine */ }
  }
  function myEntry(code) { return readStore().groups[code] || null; }
  function rememberGroup(code, patch) {
    const store = readStore();
    store.groups = store.groups || {};
    store.groups[code] = Object.assign({}, store.groups[code], patch, { seen: Date.now() });
    if (patch.name) store.name = patch.name;
    writeStore(store);
  }

  /* ---------- backend ---------- */

  async function api(action, data) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      // No custom headers → a "simple" request, which Apps Script web apps accept cross-origin.
      const res = await fetch(API_URL, { method: "POST", body: JSON.stringify(Object.assign({ action }, data)), signal: ctrl.signal });
      const out = await res.json();
      // An Apps Script deployment without group-pick.gs treats this as a menu photo upload.
      if (!out.ok && /photo/i.test(out.error || "")) throw new Error("Group Pick isn't switched on yet: the Apps Script needs the group-pick update.");
      if (!out.ok) throw new Error(out.error || "Something went wrong. Please try again.");
      return out;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("The server took too long. Please try again.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  const G = (window.HH.groupPick = { api, MIN_OVERLAP });

  function applyState(out) {
    S.group = out.group;
    S.members = out.members || [];
    rememberGroup(S.group.id, { groupName: S.group.name, date: S.group.date });
  }
  function auth() {
    const me = myEntry(S.code);
    return me ? { groupId: S.code, memberId: me.memberId, token: me.token } : null;
  }
  const meId = () => (myEntry(S.code) || {}).memberId;
  const isOrganizer = () => S.group && meId() === S.group.organizerId;

  /* ---------- data ---------- */

  function loadModel() {
    if (!S.modelPromise) {
      S.modelPromise = HH.loadData(config)
        .then((r) => { S.model = r.model; return r.model; })
        .catch((e) => { S.modelPromise = null; S.modelError = e.message || String(e); throw e; });
    }
    return S.modelPromise;
  }

  /* ---------- dates ---------- */

  function todayIso() {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: config.TIME_ZONE || "America/Los_Angeles" }).format(new Date());
    } catch (e) {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  }
  const parseIso = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return new Date(y, m - 1, d); };
  const isoOf = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const fmtDate = (iso, opts) => parseIso(iso).toLocaleDateString("en-US", opts || { weekday: "short", month: "short", day: "numeric" });
  const dayIndex = (iso) => HH.DAYS.indexOf(WEEKDAYS[parseIso(iso).getDay()]);

  /* ---------- ranking ---------- */

  const MET = "met", MISS = "missed", UNK = "unknown";
  const priceLevel = (p) => { const n = (String(p || "").match(/\$/g) || []).length; return n ? "$".repeat(Math.min(n, 3)) : ""; };
  const dealText = (s) => s.deals.map((d) => `${d.category} ${d.item} ${d.notes}`).join(" | ");

  /** One check per preference a person set: { who, label, test(candidate) → met | missed | unknown }. */
  function checksFor(m) {
    const p = m.prefs || {};
    const out = [];
    const add = (label, test, kind) => out.push({ who: m.name, label, test, kind });
    if (p.hoods && p.hoods.length) {
      add(list(p.hoods), (c) => !c.spot.neighborhood ? UNK : p.hoods.includes(c.spot.neighborhood) ? MET : MISS);
    }
    if (p.price && p.price.length) {
      add(`${p.price.join(" or ")} budget`, (c) => { const lv = priceLevel(c.spot.price); return !lv ? UNK : p.price.includes(lv) ? MET : MISS; });
    }
    if (p.food) add("food deals", (c) => !c.sched.deals.length ? UNK : c.sched.hasFood ? MET : MISS);
    (p.drinks || []).forEach((d) => {
      add(d === "Non-alcoholic" ? "non-alcoholic drinks" : d.toLowerCase(), (c) => {
        const t = dealText(c.sched);
        if (!c.sched.deals.length) return UNK;
        if (DRINK_RE[d] && DRINK_RE[d].test(t)) return MET;
        return GENERIC_DRINKS.test(t) ? UNK : MISS;
      });
    });
    if (p.table) add("table", (c) => !c.sched.seating ? UNK : isBarOnly(c.sched.seating) ? MISS : MET);
    if (p.vibe && p.vibe.length) {
      add(p.vibe.map((v) => v.toLowerCase()).join(" or "), (c) => !c.spot.type ? UNK : p.vibe.some((v) => VIBE_RE[v] && VIBE_RE[v].test(c.spot.type)) ? MET : MISS);
    }
    if (p.skip && p.skip.length) add("skip", (c) => p.skip.includes(c.spot.id) ? MISS : MET, "skip");
    return out;
  }

  function score(c, people) {
    let total = 0, counted = 0;
    c.results = [];
    people.forEach((m) => {
      const checks = checksFor(m);
      if (!checks.length) return;
      let pts = 0;
      checks.forEach((ch) => {
        const r = ch.test(c);
        pts += r === MET ? 1 : r === UNK ? 0.5 : 0;
        c.results.push({ who: ch.who, label: ch.label, kind: ch.kind, result: r });
      });
      total += pts / checks.length;
      counted++;
    });
    c.score = counted ? total / counted : 0;
    return c;
  }

  const verified = (c) => (c.sched.daysConfirmed ? 1 : 0) + (c.spot.lastVerified ? 1 : 0);
  const rankCmp = (a, b) => (b.score - a.score) ||
    (Math.min(b.overlap, 180) - Math.min(a.overlap, 180)) ||
    (verified(b) - verified(a)) || a.spot.name.localeCompare(b.spot.name);

  /** Every spot's best happy hour window on `day` for a group whose last person arrives at `latest`. */
  function windowsFor(model, day, latest) {
    const bySpot = new Map();
    model.schedules.forEach((s) => {
      if (!s.hasDays || !s.days[day] || !s.hoursKnown) return;
      if (s.start > latest + START_GRACE) return; // starts too long after everyone's there
      const overlap = s.end - Math.max(s.start, latest);
      const cur = bySpot.get(s.spot.id);
      if (!cur || overlap > cur.overlap) bySpot.set(s.spot.id, { spot: s.spot, sched: s, overlap });
    });
    return [...bySpot.values()];
  }

  function fitting(model, day, people) {
    const latest = Math.max(...people.map((m) => m.arrive));
    return windowsFor(model, day, latest).filter((c) => c.overlap >= MIN_OVERLAP).map((c) => score(c, people)).sort(rankCmp);
  }

  /** The recommendation for the current group: { state: "ok" | "conflict" | "nohh" | "empty", … }. */
  function recommend(model, iso, members) {
    const people = members.filter((m) => m.ready);
    if (!people.length) return { state: "empty" };
    const day = dayIndex(iso);
    const latest = Math.max(...people.map((m) => m.arrive));
    const late = people.filter((m) => m.arrive === latest);
    const fits = fitting(model, day, people);
    if (fits.length) return { state: "ok", latest, fits, people };

    // Nobody fits: closest = the window that runs latest past the last arrival.
    const any = windowsFor(model, day, latest).map((c) => score(c, people))
      .sort((a, b) => (b.overlap - a.overlap) || rankCmp(a, b));
    if (!any.length) return { state: "nohh", latest, late, people };

    // What would open things up: walk the late arrivals back 30 minutes at a time (the arrival choices).
    const unlocks = [];
    let prevCount = 0;
    for (let t = Math.ceil(latest / 30) * 30 - 30; t >= latest - 240 && unlocks.length < 2; t -= 30) {
      const moved = people.map((m) => (m.arrive > t ? Object.assign({}, m, { arrive: t }) : m));
      const f = fitting(model, day, moved);
      if (!f.length) continue;
      const enough = unlocks.length === 0 || f.length >= Math.max(3, prevCount + 2);
      if (!enough) continue;
      unlocks.push({ time: t, who: people.filter((m) => m.arrive > t), count: f.length, lead: f[0] });
      prevCount = f.length;
    }
    return { state: "conflict", latest, late, closest: any[0], unlocks, people };
  }
  G.recommend = recommend;

  /** One line on a runner-up's trade-off compared with the top pick. */
  function runnerNote(c, top) {
    const misses = c.results.filter((r) => r.result === MISS);
    const wins = c.results.filter((r) => r.result === MET && r.kind !== "skip" &&
      top.results.some((t) => t.who === r.who && t.label === r.label && t.result === MISS));
    const missText = misses.slice(0, 2).map((r) => r.kind === "skip" ? `${r.who} would rather skip it` : `no ${r.label} for ${r.who}`);
    const winText = wins.slice(0, 1).map((r) => `Best for ${r.who}'s ${r.label}`);
    if (winText.length && missText.length) return `${winText[0]}, but ${missText.join(" and ")}.`;
    if (missText.length) return `Close, but ${missText.join(" and ")}.`;
    if (winText.length) return `${winText[0]}.`;
    if (!c.sched.daysConfirmed) return "Close second. Its days aren't confirmed yet.";
    if (c.results.some((r) => r.result === UNK)) return "Close second. Some details aren't listed yet.";
    if (c.overlap < top.overlap) return "Close second, with a shorter happy hour after everyone arrives.";
    return "Close second.";
  }

  /* ---------- screens ---------- */

  const dlg = () => $("#gp-dialog");
  const body = () => $("#gp-body");

  function render() {
    const el = body();
    if (!el) return;
    const views = { start: viewStart, lobby: viewLobby, join: viewJoin, prefs: viewPrefs, results: viewResults, day: viewDay };
    el.innerHTML = S.loading ? viewLoading() : S.error && !S.group && S.view !== "start" ? viewError() : (views[S.view] || viewStart)();
  }

  const nav = (label, action) => `<div class="gp-nav"><button type="button" class="gp-back" data-gp="${action}">${ICON.back}${esc(label)}</button></div>`;
  const errLine = () => (S.error ? `<p class="gp-error" role="alert">${esc(S.error)}</p>` : "");
  const head = (eyebrow, title, sub) => `<div class="gp-head">${eyebrow ? `<p class="gp-eyebrow">${esc(eyebrow)}</p>` : ""}
      <h2 class="gp-title">${esc(title)}</h2>${sub ? `<p class="gp-sub">${esc(sub)}</p>` : ""}</div>`;

  function viewLoading() {
    return `<div class="gp-page">${nav("Happy Hours", "close")}<div class="loading"><span class="spinner"></span>Loading the group…</div></div>`;
  }

  function viewError() {
    return `<div class="gp-page">${nav("Happy Hours", "close")}
      <div class="empty">${ICON.people}<h3>Couldn't Open the Group</h3><p>${esc(S.error)}</p></div>
      <button type="button" class="gp-btn" data-gp="start">Start a new group</button></div>`;
  }

  function calendar(cal) {
    const today = todayIso();
    const first = new Date(cal.y, cal.m, 1).getDay();
    const count = new Date(cal.y, cal.m + 1, 0).getDate();
    const [ty, tm] = today.split("-").map(Number);
    const atStart = cal.y === ty && cal.m === tm - 1;
    let cells = "";
    for (let i = 0; i < first; i++) cells += "<span></span>";
    for (let d = 1; d <= count; d++) {
      const iso = isoOf(cal.y, cal.m, d);
      const past = iso < today;
      cells += `<button type="button" class="gp-day${iso === today ? " is-today" : ""}" data-gp="cal-day" data-date="${iso}"
        aria-pressed="${iso === cal.sel}" aria-label="${esc(fmtDate(iso, { weekday: "long", month: "long", day: "numeric" }))}"${past ? " disabled" : ""}>${d}</button>`;
    }
    return `<div class="gp-cal">
      <div class="gp-cal-head">
        <span class="gp-cal-month">${MONTHS[cal.m]} ${cal.y}</span>
        <span class="gp-cal-arrows">
          <button type="button" class="gp-cal-arrow" data-gp="cal-prev" aria-label="Previous month"${atStart ? " disabled" : ""}>${ICON.back}</button>
          <button type="button" class="gp-cal-arrow" data-gp="cal-next" aria-label="Next month">${ICON.next}</button>
        </span>
      </div>
      <div class="gp-cal-grid gp-cal-dow" aria-hidden="true"><span>SUN</span><span>MON</span><span>TUE</span><span>WED</span><span>THU</span><span>FRI</span><span>SAT</span></div>
      <div class="gp-cal-grid">${cells}</div>
    </div>`;
  }

  function viewStart() {
    const store = readStore();
    const recent = Object.entries(store.groups || {})
      .filter(([, g]) => g.date && g.date >= todayIso())
      .sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0)).slice(0, 4);
    const recentHtml = recent.length ? `<div class="gp-section"><p class="gp-label">Your groups</p><div class="gp-card gp-rows">
        ${recent.map(([code, g]) => `<button type="button" class="gp-link-row" data-gp="open-group" data-code="${esc(code)}">
          <span class="gp-member-text"><span class="gp-name">${esc(g.groupName || "Group")}</span><small>${esc(fmtDate(g.date))}</small></span>${ICON.next}</button>`).join("")}
      </div></div>` : "";
    return `<div class="gp-page">
      <div class="gp-nav"><button type="button" class="gp-back" data-gp="close">Cancel</button></div>
      ${head("", "Group Pick", "")}
      <p class="gp-lead">Everyone says when they can get there and what they'd like. We'll find the spot that suits the group best.</p>
      ${recentHtml}
      <div class="gp-section"><label class="gp-label" for="gp-outing">Outing name</label>
        <input id="gp-outing" class="gp-input" data-field="startName" maxlength="60" placeholder="Friday wind-down" value="${esc(S.startName)}"></div>
      <div class="gp-section"><div class="gp-label-row"><span class="gp-label">Day</span><span class="gp-picked">${esc(fmtDate(S.cal.sel, { weekday: "long", month: "short", day: "numeric" }))}</span></div>
        ${calendar(S.cal)}</div>
      <div class="gp-section"><label class="gp-label" for="gp-yourname">Your name</label>
        <input id="gp-yourname" class="gp-input" data-field="yourName" maxlength="40" autocomplete="given-name" value="${esc(S.yourName)}"></div>
      ${errLine()}
      <div class="gp-spacer"></div>
      <button type="button" class="gp-btn" data-gp="create"${S.busy ? " disabled" : ""}>${S.busy ? "Creating…" : "Create &amp; share link"}</button>
    </div>`;
  }

  function groupUrl() {
    return `${location.origin}${location.pathname}#g=${S.code}`;
  }

  function memberLine(m) {
    if (!m.ready) return "Joined · adding preferences";
    const p = m.prefs || {};
    const n = (p.hoods || []).length + (p.price || []).length + (p.food ? 1 : 0) + (p.drinks || []).length +
      (p.table ? 1 : 0) + (p.vibe || []).length + (p.skip || []).length;
    return `There by ${fmtTime(m.arrive)} · ${n ? `${n} preference${n === 1 ? "" : "s"}` : "easy-going"}`;
  }

  function lockedBanner() {
    const id = S.group && S.group.lockedSpotId;
    if (!id) return "";
    const spot = S.model && S.model.spots.get(id);
    return `<div class="gp-info gp-locked">${ICON.lock}<span>Going to <b>${esc(spot ? spot.name : "the locked-in spot")}</b>.</span></div>`;
  }

  function viewLobby() {
    const g = S.group;
    const ready = S.members.filter((m) => m.ready).length;
    const me = meId();
    const mine = S.members.find((m) => m.id === me);
    const org = S.members.find((m) => m.id === g.organizerId);
    const waiting = S.members.filter((m) => !m.ready).map((m) => m.name);
    const note = !ready ? "The pick appears once someone adds when they can get there."
      : waiting.length ? `You can see the pick now. It updates as ${list(waiting)} ${waiting.length === 1 ? "adds" : "add"} preferences, and everyone sees the same result.`
      : "Everyone's in. Everyone sees the same result.";
    return `<div class="gp-page">
      ${nav("Happy Hours", "close")}
      ${head("", g.name, `${fmtDate(g.date, { weekday: "short", month: "short", day: "numeric" })} · Organized by ${isOrganizer() ? "you" : (org ? org.name : "a friend")}`)}
      ${isOrganizer() ? `<button type="button" class="gp-text-btn" data-gp="change-day">Change day</button>` : ""}
      ${lockedBanner()}
      <div class="gp-card gp-pad gp-invite">
        <div class="gp-link-head"><span class="gp-ico">${ICON.link}</span>
          <span class="gp-member-text"><span class="gp-name">Invite link</span><small class="gp-url">${esc(groupUrl().replace(/^https?:\/\//, ""))}</small></span></div>
        <div class="gp-grid2">
          <button type="button" class="gp-tile" data-gp="copy">${S.copied ? "Copied" : "Copy link"}</button>
          <button type="button" class="gp-tile" data-gp="share">Share…</button>
        </div>
      </div>
      <div class="gp-section">
        <div class="gp-label-row"><h3 class="gp-h3">Who's in</h3><span class="gp-count">${ready} of ${S.members.length} have added prefs</span></div>
        <div class="gp-card gp-rows">
          ${S.members.map((m) => `<div class="gp-member">
            <span class="gp-avatar" aria-hidden="true">${esc((m.name || "?").charAt(0).toUpperCase())}</span>
            <span class="gp-member-text"><span class="gp-name">${esc(m.name)}${m.id === me ? " (you)" : ""}</span><small>${esc(memberLine(m))}</small></span>
            <span class="gp-pill ${m.ready ? "ok" : "wait"}">${m.ready ? "Ready" : "Adding…"}</span></div>`).join("")}
        </div>
        ${mine ? `<button type="button" class="gp-text-btn" data-gp="prefs">${mine.ready ? "Edit my preferences" : "Add my preferences"}</button>`
               : `<button type="button" class="gp-text-btn" data-gp="join-view">Join this group</button>`}
      </div>
      <div class="gp-spacer"></div>
      <div class="gp-foot">
        <p class="gp-note">${esc(note)}</p>
        <button type="button" class="gp-btn" data-gp="results"${ready ? "" : " disabled"}>See recommendation</button>
      </div>
    </div>`;
  }

  function viewJoin() {
    const g = S.group;
    const org = S.members.find((m) => m.id === g.organizerId);
    const avatars = S.members.slice(0, 4).map((m) => `<span class="gp-avatar">${esc((m.name || "?").charAt(0).toUpperCase())}</span>`).join("");
    return `<div class="gp-page gp-join">
      ${nav("Happy Hours", "close")}
      <div class="gp-join-hero">
        <div class="gp-avatars" aria-hidden="true">${avatars}</div>
        <p class="gp-sub">${esc(org ? org.name : "A friend")} invited you to</p>
        <h2 class="gp-title">${esc(g.name)}</h2>
        <p class="gp-sub">Happy hour · ${esc(fmtDate(g.date))} · ${esc(config.APP_SUBTITLE || "")}</p>
      </div>
      <div class="gp-card gp-pad gp-steps">
        <h3 class="gp-h4">How it works</h3>
        <ol>
          <li>Say when you can get there. That's the only thing we won't compromise on.</li>
          <li>Add what you'd like: neighborhood, budget, food and drinks, seating and vibe.</li>
          <li>Everyone sees the same pick, plus two runners-up.</li>
        </ol>
      </div>
      <div class="gp-section"><label class="gp-label" for="gp-joinname">Your name</label>
        <input id="gp-joinname" class="gp-input" data-field="joinName" maxlength="40" autocomplete="given-name" value="${esc(S.joinName)}">
        <p class="gp-hint">Shown to the group. No account needed.</p></div>
      ${errLine()}
      <div class="gp-spacer"></div>
      <div class="gp-foot">
        <button type="button" class="gp-btn" data-gp="join"${S.busy ? " disabled" : ""}>${S.busy ? "Joining…" : "Add my preferences"}</button>
        <button type="button" class="gp-btn-2" data-gp="results">Skip — I'm easy, just show the pick</button>
      </div>
    </div>`;
  }

  function hoodOptions() {
    if (!S.model) return FALLBACK_HOODS;
    const counts = {};
    S.model.spots.forEach((s) => { if (s.neighborhood) counts[s.neighborhood] = (counts[s.neighborhood] || 0) + 1; });
    const hoods = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    return hoods.length ? hoods : FALLBACK_HOODS;
  }

  function chips(key, options, selected, labels) {
    return `<div class="gp-chips" data-key="${key}">${options.map((o, i) =>
      `<button type="button" class="gp-chip" data-gp="chip" data-key="${key}" data-value="${esc(o)}" aria-pressed="${selected.includes(o)}">${esc(labels ? labels[i] : o)}</button>`).join("")}</div>`;
  }

  function prefRow(title, inner, opts = {}) {
    return `<div class="gp-row"><div class="gp-row-head"><span class="gp-row-title">${esc(title)}</span>${opts.required ? '<span class="gp-req">Required</span>' : ""}</div>
      ${opts.hint ? `<p class="gp-hint">${esc(opts.hint)}</p>` : ""}${inner}</div>`;
  }

  function viewPrefs() {
    const d = S.draft;
    const g = S.group;
    const me = S.members.find((m) => m.id === meId());
    const spots = S.model ? [...S.model.spots.values()].sort((a, b) => a.name.localeCompare(b.name)) : [];
    const skipChips = d.skip.map((id) => {
      const s = S.model && S.model.spots.get(id);
      return `<button type="button" class="gp-chip" data-gp="unskip" data-value="${esc(id)}" aria-pressed="true" aria-label="Remove ${esc(s ? s.name : id)}">${esc(s ? s.name : id)} ✕</button>`;
    }).join("");
    const skipSelect = spots.length ? `<select class="gp-select" data-gp-select="skip" aria-label="Add a spot to skip">
        <option value="">+ Add a spot</option>${spots.filter((s) => !d.skip.includes(s.id)).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>` : "";
    return `<div class="gp-page">
      <div class="gp-nav"><button type="button" class="gp-back" data-gp="lobby">${ICON.back}Group</button>
        <button type="button" class="gp-text-btn" data-gp="prefs-reset">Reset</button></div>
      ${head("", "Your preferences", `${g.name} · ${fmtDate(g.date)}${me ? ` · as ${me.name}` : ""}`)}
      <p class="gp-lead">Your arrival time is the only requirement: happy hour has to run at least ${MIN_OVERLAP} minutes after the last person gets there. Everything else helps rank the spots.</p>

      <div class="gp-section"><p class="gp-label">Where &amp; when</p><div class="gp-card gp-rows">
        ${prefRow("I can get there by", chips("arrive", ARRIVE_TIMES.map(String), d.arrive == null ? [] : [String(d.arrive)], ARRIVE_TIMES.map(fmtTime)), { required: true })}
        ${prefRow("Neighborhoods", chips("hoods", hoodOptions(), d.hoods))}
      </div></div>

      <div class="gp-section"><p class="gp-label">Budget</p><div class="gp-card gp-rows">
        ${prefRow("Price level", chips("price", PRICES, d.price))}
      </div></div>

      <div class="gp-section"><p class="gp-label">Food &amp; drink</p><div class="gp-card gp-rows">
        ${prefRow("Food", chips("food", ["yes"], d.food ? ["yes"] : [], ["Food deals"]))}
        ${prefRow("Drinks", chips("drinks", DRINKS, d.drinks))}
      </div></div>

      <div class="gp-section"><p class="gp-label">Seating &amp; vibe</p><div class="gp-card gp-rows">
        ${prefRow("Seating", chips("table", ["yes"], d.table ? ["yes"] : [], ["Table, not bar-only"]))}
        ${prefRow("Vibe", chips("vibe", VIBES, d.vibe))}
        ${prefRow("Rather skip", `<div class="gp-chips">${skipChips}${skipSelect}</div>`)}
      </div></div>

      ${errLine()}
      <div class="gp-spacer"></div>
      <button type="button" class="gp-btn" id="gp-save" data-gp="save"${d.arrive == null || S.busy ? " disabled" : ""}>${S.busy ? "Saving…" : "Save preferences"}</button>
    </div>`;
  }

  function spotMeta(spot, extra) {
    return [spot.neighborhood, spot.type, spot.price, extra].filter(Boolean).join(" · ");
  }

  function spotActions(spot) {
    const maps = spot.mapsUrl || (spot.address ? `https://maps.google.com/?q=${encodeURIComponent(`${spot.name}, ${spot.address}`)}` : "");
    const links = [[maps, "Directions"], [spot.website, "Website"], [spot.yelpUrl, "Yelp"]].filter(([u]) => u);
    if (!links.length) return "";
    return `<div class="gp-grid${links.length}">${links.map(([u, l]) =>
      `<a class="gp-tile tint" href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join("")}</div>`;
  }

  function topCard(c, latest, pill) {
    const deals = c.sched.deals.slice(0, 3).map((d) => {
      const f = HH.formatDeal(d);
      return `<li><span>${esc(f.item)}</span><b>${esc(f.lead)}</b></li>`;
    }).join("");
    return `<article class="gp-card gp-pad gp-spot">
      <div class="gp-spot-head"><div><h3>${esc(c.spot.name)}</h3><p class="sub">${esc(spotMeta(c.spot))}</p></div>${pill}</div>
      <p class="gp-when">${ICON.clock}${esc(HH.formatWindow(c.sched))} · everyone there by ${esc(fmtTime(latest))}</p>
      ${deals ? `<ul class="gp-deals">${deals}</ul>` : ""}
      ${spotActions(c.spot)}
    </article>`;
  }

  function resultsFoot(spot) {
    const member = S.members.some((m) => m.id === meId());
    const locked = S.group.lockedSpotId && spot && S.group.lockedSpotId === spot.id;
    const main = !spot ? "" : isOrganizer() && !locked
      ? `<button type="button" class="gp-btn" data-gp="lock" data-spot="${esc(spot.id)}"${S.busy ? " disabled" : ""}>Lock in ${esc(spot.name)} &amp; tell the group</button>`
      : `<button type="button" class="gp-btn" data-gp="share-pick" data-spot="${esc(spot.id)}">Share this pick</button>`;
    return `<div class="gp-foot">${main}
      <button type="button" class="gp-btn-2" data-gp="${member ? "prefs" : "join-view"}">${member ? "Change my preferences" : "Add my preferences"}</button></div>`;
  }

  function viewResults() {
    const g = S.group;
    const top = `${nav("Group", "lobby")}${head(`${g.name} · ${fmtDate(g.date)}`, "The group's pick", "")}`;
    if (!S.model) {
      return `<div class="gp-page">${top}${S.modelError
        ? `<div class="empty"><h3>Couldn't Load Happy Hours</h3><p>${esc(S.modelError)}</p></div>`
        : '<div class="loading"><span class="spinner"></span>Finding the best spot…</div>'}</div>`;
    }
    const rec = recommend(S.model, g.date, S.members);
    const waiting = S.members.filter((m) => !m.ready);
    const ready = S.members.length - waiting.length;
    const waitNote = waiting.length && ready
      ? `<div class="gp-info">${ICON.clock}<span>Based on ${ready} of ${S.members.length} people. ${esc(list(waiting.map((m) => m.name)))} ${waiting.length === 1 ? "is" : "are"} still adding preferences, so this may change.</span></div>` : "";
    const weekday = WEEKDAY_NAMES[parseIso(g.date).getDay()];

    if (rec.state === "empty") {
      return `<div class="gp-page">${top}<div class="empty">${ICON.people}<h3>No Preferences Yet</h3>
        <p>The pick appears once someone adds when they can get there.</p></div>${resultsFoot(null)}</div>`;
    }

    if (rec.state === "nohh") {
      return `<div class="gp-page">${top}${waitNote}
        <div class="gp-warn">${ICON.warn}<div><h3>No happy hours on ${esc(weekday)}</h3><p>We don't have any happy hours listed for that day.</p></div></div>
        ${isOrganizer() ? '<button type="button" class="gp-btn" data-gp="change-day">Try a different day</button>' : ""}
        ${resultsFoot(null)}</div>`;
    }

    if (rec.state === "conflict") {
      const c = rec.closest;
      const names = list(rec.late.map((m) => m.name));
      const minsFor = Math.max(0, c.overlap);
      const lateText = minsFor > 0
        ? `${names} would get ${minsFor} minutes of happy hour.`
        : `Happy hour ends at ${fmtTime(c.sched.end % HH.END_OF_DAY)}, before ${names} can get there.`;
      const unlocks = rec.unlocks.map((u, i) => {
        const who = list(u.who.map((m) => m.name));
        const then = u.count === 1 ? `${u.lead.spot.name} works for everyone.` : `${u.count} spots work, led by ${u.lead.spot.name}.`;
        const askLabel = S.asked[i] ? "Asked" : `Ask ${u.who.length === 1 ? u.who[0].name : "them"}`;
        return `<div class="gp-unlock"><span class="gp-member-text"><span class="gp-name">If ${esc(who)} can get there by ${esc(fmtTime(u.time))}</span><small>${esc(then)}</small></span>
          <button type="button" class="gp-ask" data-gp="ask" data-i="${i}" data-time="${u.time}" data-who="${esc(who)}">${esc(askLabel)}</button></div>`;
      }).join("");
      return `<div class="gp-page">${top}${waitNote}
        <div class="gp-warn">${ICON.warn}<div><h3>No happy hour fits everyone's arrival</h3>
          <p>${esc(names)} can get there by ${esc(fmtTime(rec.latest))}. No happy hour runs until ${esc(fmtTime(rec.latest + MIN_OVERLAP))} on ${esc(weekday)}. Here's the closest.</p></div></div>
        <article class="gp-card gp-pad gp-spot">
          <div class="gp-spot-head"><div><h3>${esc(c.spot.name)}</h3><p class="sub">${esc(spotMeta(c.spot, HH.formatWindow(c.sched)))}</p></div><span class="gp-pill warn">CLOSEST</span></div>
          <p class="gp-why">${esc(lateText)}</p>
          ${spotActions(c.spot)}
        </article>
        ${unlocks || isOrganizer() ? `<div class="gp-section"><h3 class="gp-h3">What would open things up</h3><div class="gp-card gp-rows">${unlocks}
          ${isOrganizer() ? '<button type="button" class="gp-link-row gp-tint" data-gp="change-day"><span>Try a different day</span></button>' : ""}</div>
          ${unlocks ? '<p class="gp-hint gp-hint-pad">Asking sends a message you can text them. Only they can change their arrival time.</p>' : ""}</div>` : ""}
        <div class="gp-spacer"></div>
        ${resultsFoot(c.spot)}</div>`;
    }

    // state "ok"
    const lockedId = g.lockedSpotId;
    let fits = rec.fits;
    let pick = fits[0];
    let pill = '<span class="gp-pill">TOP PICK</span>';
    if (lockedId) {
      const locked = fits.find((c) => c.spot.id === lockedId);
      if (locked) { pick = locked; pill = `<span class="gp-pill ok">LOCKED IN</span>`; }
    }
    const runners = fits.filter((c) => c !== pick).slice(0, 2);
    const runnersHtml = runners.length ? `<div class="gp-section"><h3 class="gp-h3">Runners-up</h3>
      ${runners.map((c, i) => `<article class="gp-card gp-pad gp-runner">
        <h4>${i + 2}&nbsp;&nbsp;${esc(c.spot.name)}</h4>
        <p class="sub">${esc(spotMeta(c.spot, HH.formatWindow(c.sched)))}</p>
        <p class="gp-why">${esc(runnerNote(c, pick))}</p></article>`).join("")}</div>` : "";
    return `<div class="gp-page">${top}${waitNote}
      ${topCard(pick, rec.latest, pill)}
      ${runnersHtml}
      <div class="gp-spacer"></div>
      ${resultsFoot(pick.spot)}</div>`;
  }

  function viewDay() {
    return `<div class="gp-page">
      <div class="gp-nav"><button type="button" class="gp-back" data-gp="lobby">${ICON.back}Group</button></div>
      ${head("", "Change day", "Everyone's preferences stay. A locked-in spot is cleared.")}
      <div class="gp-section"><div class="gp-label-row"><span class="gp-label">Day</span><span class="gp-picked">${esc(fmtDate(S.cal.sel, { weekday: "long", month: "short", day: "numeric" }))}</span></div>
        ${calendar(S.cal)}</div>
      ${errLine()}
      <div class="gp-spacer"></div>
      <button type="button" class="gp-btn" data-gp="save-day"${S.busy ? " disabled" : ""}>${S.busy ? "Saving…" : "Save day"}</button>
    </div>`;
  }

  /* ---------- navigation ---------- */

  function show(view) {
    S.view = view;
    S.error = "";
    render();
    const sc = $("#gp-scroll");
    if (sc) sc.scrollTop = 0;
    managePolling();
  }

  function openDialog() {
    const d = dlg();
    if (!d) return;
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute("open", ""); }
    document.documentElement.classList.add("gp-open");
  }

  function closeDialog() {
    const d = dlg();
    if (d && d.open) { if (d.close) d.close(); else d.removeAttribute("open"); }
  }

  function onClosed() {
    document.documentElement.classList.remove("gp-open");
    stopPolling();
    S.view = null;
    S.code = null;
    if (/#g=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  }

  function calFor(iso) {
    const d = parseIso(iso);
    return { y: d.getFullYear(), m: d.getMonth(), sel: iso };
  }

  function nextFriday() {
    const t = parseIso(todayIso());
    const add = (5 - t.getDay() + 7) % 7;
    t.setDate(t.getDate() + add);
    return isoOf(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function openStart() {
    S.code = null; S.group = null; S.members = [];
    S.cal = calFor(nextFriday());
    S.startName = "";
    S.yourName = readStore().name || "";
    S.loading = false;
    openDialog();
    show("start");
  }

  async function openGroup(code, view) {
    S.code = code;
    S.group = null; S.members = []; S.asked = {}; S.copied = false;
    S.loading = true; S.error = "";
    openDialog();
    render();
    loadModel().then(() => { if (S.view === "results" || S.view === "prefs" || S.view === "lobby") render(); }).catch(() => { if (S.view === "results") render(); });
    try {
      applyState(await G.api("groupGet", { groupId: code }));
      S.loading = false;
      const member = S.members.some((m) => m.id === meId());
      if (!member && myEntry(code)) {
        // This phone's entry points at a member who isn't in the group anymore.
        const store = readStore(); delete store.groups[code]; writeStore(store);
      }
      S.joinName = readStore().name || "";
      show(view || (S.members.some((m) => m.id === meId()) ? "lobby" : "join"));
    } catch (e) {
      S.loading = false;
      S.error = e.message || String(e);
      S.view = "lobby";
      render();
    }
  }

  async function refresh() {
    if (!S.code || S.busy || !["lobby", "results"].includes(S.view)) return;
    try { applyState(await G.api("groupGet", { groupId: S.code })); if (["lobby", "results"].includes(S.view)) render(); }
    catch (e) { /* keep what's on screen */ }
  }
  function managePolling() {
    stopPolling();
    if (["lobby", "results"].includes(S.view)) S.poll = setInterval(refresh, POLL_MS);
  }
  function stopPolling() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }

  /* ---------- actions ---------- */

  async function run(fn) {
    if (S.busy) return;
    S.busy = true; S.error = ""; render();
    try { await fn(); } catch (e) { S.error = e.message || String(e); }
    S.busy = false; render();
  }

  function startDraft() {
    const mine = S.members.find((m) => m.id === meId());
    const p = (mine && mine.prefs) || {};
    S.draft = {
      arrive: mine && mine.ready ? mine.arrive : null,
      hoods: [...(p.hoods || [])], price: [...(p.price || [])], food: !!p.food,
      drinks: [...(p.drinks || [])], table: !!p.table, vibe: [...(p.vibe || [])], skip: [...(p.skip || [])],
    };
  }

  async function share(text, url) {
    try {
      if (navigator.share) { await navigator.share({ text, url }); return true; }
    } catch (e) { if (e.name === "AbortError") return false; }
    try { await navigator.clipboard.writeText(url ? `${text} ${url}` : text); alert("Copied. Paste it into your group chat."); return true; }
    catch (e) { prompt("Copy this:", url ? `${text} ${url}` : text); return true; }
  }

  function toggleChip(btn) {
    const key = btn.dataset.key;
    const value = btn.dataset.value;
    const d = S.draft;
    const wrap = btn.parentElement;
    if (key === "arrive") {
      d.arrive = Number(value);
      wrap.querySelectorAll(".gp-chip").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      const save = $("#gp-save"); if (save) save.disabled = false;
      return;
    }
    if (key === "food" || key === "table") {
      d[key] = !d[key];
      btn.setAttribute("aria-pressed", String(d[key]));
      return;
    }
    const arr = d[key];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1); else arr.push(value);
    btn.setAttribute("aria-pressed", String(i < 0));
  }

  async function onClick(e) {
    const btn = e.target.closest("[data-gp]");
    if (!btn || btn.disabled) return;
    const a = btn.dataset.gp;
    switch (a) {
      case "close": closeDialog(); break;
      case "start": openStart(); break;
      case "open-group": history.replaceState(null, "", `#g=${btn.dataset.code}`); openGroup(btn.dataset.code); break;
      case "lobby": show("lobby"); break;
      case "join-view": show("join"); break;
      case "results": show("results"); loadModel().then(render, render); break;
      case "prefs": startDraft(); show("prefs"); loadModel().then(() => S.view === "prefs" && render(), () => {}); break;
      case "prefs-reset": startDraft(); render(); break;
      case "chip": toggleChip(btn); break;
      case "unskip": S.draft.skip = S.draft.skip.filter((id) => id !== btn.dataset.value); render(); break;
      case "cal-prev": case "cal-next": {
        const step = a === "cal-next" ? 1 : -1;
        let m = S.cal.m + step, y = S.cal.y;
        if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
        S.cal = Object.assign({}, S.cal, { y, m });
        render();
        break;
      }
      case "cal-day": S.cal.sel = btn.dataset.date; render(); break;
      case "change-day": S.cal = calFor(S.group.date); show("day"); break;
      case "create":
        if (!S.yourName.trim()) { S.error = "Add your name so friends know who invited them."; render(); return; }
        await run(async () => {
          const out = await G.api("groupCreate", { name: S.startName.trim() || "Happy hour", date: S.cal.sel, memberName: S.yourName.trim() });
          S.code = out.group.id;
          rememberGroup(S.code, { memberId: out.memberId, token: out.token, name: S.yourName.trim() });
          applyState(out);
          history.replaceState(null, "", `#g=${S.code}`);
          S.view = "lobby";
        });
        managePolling();
        break;
      case "join":
        if (!S.joinName.trim()) { S.error = "Add your name so the group knows who you are."; render(); return; }
        await run(async () => {
          const out = await G.api("groupJoin", { groupId: S.code, memberName: S.joinName.trim() });
          rememberGroup(S.code, { memberId: out.memberId, token: out.token, name: S.joinName.trim() });
          applyState(out);
          startDraft();
          S.view = "prefs";
        });
        loadModel().then(() => S.view === "prefs" && render(), () => {});
        break;
      case "save": {
        const d = S.draft;
        await run(async () => {
          applyState(await G.api("groupSave", Object.assign(auth() || {}, {
            arrive: d.arrive, prefs: { hoods: d.hoods, price: d.price, food: d.food, drinks: d.drinks, table: d.table, vibe: d.vibe, skip: d.skip },
          })));
          S.view = "lobby";
        });
        managePolling();
        break;
      }
      case "save-day":
        await run(async () => {
          applyState(await G.api("groupUpdate", Object.assign(auth() || {}, { date: S.cal.sel })));
          S.view = "lobby";
        });
        managePolling();
        break;
      case "copy":
        try { await navigator.clipboard.writeText(groupUrl()); } catch (err) { prompt("Copy this link:", groupUrl()); }
        S.copied = true; render();
        setTimeout(() => { S.copied = false; if (S.view === "lobby") render(); }, 2500);
        break;
      case "share":
        share(`Help pick a happy hour spot for ${S.group.name} (${fmtDate(S.group.date)}): add when you can get there and what you'd like.`, groupUrl());
        break;
      case "lock": {
        const spot = S.model.spots.get(btn.dataset.spot);
        await run(async () => { applyState(await G.api("groupLock", Object.assign(auth() || {}, { spotId: spot.id }))); });
        sharePick(spot);
        break;
      }
      case "share-pick": sharePick(S.model.spots.get(btn.dataset.spot)); break;
      case "ask":
        S.asked[btn.dataset.i] = true;
        render();
        share(`${btn.dataset.who}, could you get to ${S.group.name} by ${fmtTime(Number(btn.dataset.time))}? It opens up more happy hour spots for ${fmtDate(S.group.date)}.`, groupUrl());
        break;
      default: break;
    }
  }

  function sharePick(spot) {
    if (!spot) return;
    const rec = recommend(S.model, S.group.date, S.members);
    const c = rec.fits ? rec.fits.find((x) => x.spot.id === spot.id) : rec.closest;
    const when = c ? `, happy hour ${HH.formatWindow(c.sched)}` : "";
    share(`We're going to ${spot.name} on ${fmtDate(S.group.date)}${when}.`, groupUrl());
  }

  function onInput(e) {
    const f = e.target.dataset && e.target.dataset.field;
    if (f) S[f] = e.target.value;
  }

  function onChange(e) {
    if (e.target.dataset && e.target.dataset.gpSelect === "skip" && e.target.value) {
      S.draft.skip.push(e.target.value);
      render();
    }
  }

  /* ---------- setup ---------- */

  function codeFromHash() {
    const m = location.hash.match(/[#&]g=([A-Za-z0-9]{4,10})/);
    return m ? m[1].toUpperCase() : null;
  }

  function start() {
    const d = dlg();
    const btn = $("#group-btn");
    if (!d || !btn || !API_URL) return; // older cached index.html, or no backend configured
    btn.hidden = false;
    btn.addEventListener("click", () => {
      const code = codeFromHash();
      if (code) openGroup(code); else openStart();
    });
    d.addEventListener("click", onClick);
    d.addEventListener("input", onInput);
    d.addEventListener("change", onChange);
    d.addEventListener("close", onClosed);
    d.addEventListener("cancel", () => { /* Escape key: let it close */ });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
    window.addEventListener("hashchange", () => { const c = codeFromHash(); if (c && c !== S.code) openGroup(c); });
    const code = codeFromHash();
    if (code) openGroup(code);
  }

  G.start = start;
  G.state = S;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
