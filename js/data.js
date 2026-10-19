/*
 * data.js — loads the three sheet tabs, turns rows into clean objects, links them together,
 * and works out each happy hour's status ("now", "soon", "later", "ended"…).
 * No page/DOM code lives here; that's all in app.js.
 *
 * Data model (one Google Sheet, three tabs, linked by IDs):
 *   Spots      one row per restaurant/bar            key: Spot ID      (S01)
 *   Schedules  one row per happy hour window/special  key: Schedule ID  (H001) → Spot ID
 *   Deals      one row per deal                       key: Deal ID      (D001) → Spot ID, optional Schedule ID
 *   A deal with a blank Schedule ID applies to all of that spot's "Happy hour" and "Late night" windows.
 */
window.HH = window.HH || {};

/*
 * COLUMNS — the sheet's column headers, in one place.
 * If you rename a column in the sheet, change it here too. Column ORDER doesn't matter,
 * and extra columns in the sheet are simply ignored.
 */
HH.COLUMNS = {
  spots: {
    id: "Spot ID", name: "Name", neighborhood: "Neighborhood", type: "Type", address: "Address",
    phone: "Phone", website: "Website", mapsUrl: "Google Maps link", yelpUrl: "Yelp link",
    price: "Price ($-$$$$)", seating: "HH seating", reservations: "Reservations for HH?",
    status: "Status", lastVerified: "Last verified", notes: "Notes", lat: "Latitude", lng: "Longitude",
  },
  schedules: {
    id: "Schedule ID", spotId: "Spot ID", label: "Label", kind: "Kind",
    start: "Start", end: "End", timeNote: "Time note", seating: "Seating (if different)",
    daysConfirmed: "Days confirmed?", notes: "Notes",
    // plus one TRUE/FALSE column per day, named exactly as in HH.DAYS (Mon … Sun)
  },
  deals: {
    id: "Deal ID", spotId: "Spot ID", scheduleId: "Schedule ID", category: "Category",
    item: "Item", price: "Price ($)", discount: "Discount", notes: "Notes",
  },
};

/* ---------- small value cleaners ---------- */

const truthy = (v) => /^(true|yes|y|x|1|✓|✔)$/i.test(String(v || "").trim());
const falsy = (v) => /^(false|no|n|0)$/i.test(String(v || "").trim());
const toNumber = (v) => {
  const n = parseFloat(String(v || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const clean = (v) => String(v == null ? "" : v).trim();
const pick = (row, header) => clean(row[header]);

/* ---------- loading ---------- */
/*
 * Two ways to read the sheet:
 *  1. GOOGLE_SHEET_ID → Google's "gviz" endpoint loaded as a <script> tag (JSONP).
 *     A script tag isn't subject to browser cross-origin (CORS) rules, so this works both
 *     on a hosted site and when index.html is opened straight from your computer (file://).
 *     If that fails, it retries the same endpoint as CSV with fetch().
 *  2. CSV_URLS (all three filled in) → plain fetch() of "Publish to web" CSV links.
 * Both produce the same thing: an array of row objects keyed by column header.
 */

const KEYS = ["spots", "schedules", "deals"];

const csvUrlsConfigured = (config) => {
  const u = config.CSV_URLS || {};
  return Boolean(u.spots && u.schedules && u.deals);
};

/** gviz CSV URL for one tab (used by the fetch() fallback). */
HH.gvizCsvUrl = function gvizCsvUrl(sheetId, tabName) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tabName)}`;
};

async function fetchCsvRows(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  const text = await res.text();
  // A private sheet returns a Google sign-in page instead of CSV.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error("Got a web page instead of data. Is the sheet shared as 'Anyone with the link → Viewer'?");
  }
  return HH.parseCSV(text);
}

/** Turn a gviz table ({cols, rows}) into row objects keyed by header, as text. */
HH.gvizTableToRows = function gvizTableToRows(table) {
  const cols = table.cols || [];
  const headers = cols.map((c, i) => String(c.label || "").trim() || `Column ${i + 1}`);
  return (table.rows || [])
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        const cell = (r.c || [])[i];
        let v = "";
        if (cell) {
          // Numbers: raw value (keeps full precision, e.g. latitude). Everything else:
          // the formatted text you see in the sheet ("2:00 PM", "TRUE", "$7.00").
          if (cols[i].type === "number" && typeof cell.v === "number") v = String(cell.v);
          else if (cell.f != null) v = cell.f;
          else if (typeof cell.v === "boolean") v = cell.v ? "TRUE" : "FALSE";
          else if (cell.v != null) v = cell.v;
        }
        obj[h] = String(v).trim();
      });
      return obj;
    })
    .filter((row) => Object.values(row).some((v) => v !== ""));
};

let jsonpCount = 0;
/** Load one tab with a <script> tag (JSONP). Resolves to row objects. */
HH.loadTabJsonp = function loadTabJsonp(sheetId, tabName, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cb = `hhSheetCallback_${Date.now()}_${jsonpCount++}`;
    const script = document.createElement("script");
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out loading the "${tabName}" tab.`)), timeoutMs);

    window[cb] = (resp) => {
      if (!resp || resp.status === "error") {
        const e = resp && resp.errors && resp.errors[0];
        const msg = e ? e.detailed_message || e.message : "unknown error";
        finish(reject, new Error(`Google Sheets couldn't read the "${tabName}" tab: ${msg}`));
      } else {
        finish(resolve, HH.gvizTableToRows(resp.table));
      }
    };
    script.onerror = () => finish(reject, new Error(`Couldn't reach Google Sheets for the "${tabName}" tab.`));
    // If the script loaded but never called back, Google sent a sign-in page (sheet not shared).
    script.onload = () => setTimeout(() => finish(reject, new Error(
      "Google didn't return data. Is the sheet shared as 'Anyone with the link → Viewer'?")), 50);

    const tqx = encodeURIComponent(`out:json;responseHandler:${cb}`);
    script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=${tqx}&headers=1&sheet=${encodeURIComponent(tabName)}`;
    document.head.appendChild(script);
  });
};

/** Load all three tabs from the sheet. Resolves to { spots: [...], schedules: [...], deals: [...] }. */
async function loadFromSheet(config) {
  const raw = {};
  if (csvUrlsConfigured(config)) {
    const lists = await Promise.all(KEYS.map((k) => fetchCsvRows(config.CSV_URLS[k])));
    KEYS.forEach((k, i) => { raw[k] = lists[i]; });
    return raw;
  }
  const id = config.GOOGLE_SHEET_ID;
  let lists;
  try {
    lists = await Promise.all(KEYS.map((k) => HH.loadTabJsonp(id, config.TAB_NAMES[k])));
  } catch (jsonpError) {
    try {
      lists = await Promise.all(KEYS.map((k) => fetchCsvRows(HH.gvizCsvUrl(id, config.TAB_NAMES[k]))));
    } catch (fetchError) {
      throw jsonpError; // the first error is usually the more helpful one
    }
  }
  KEYS.forEach((k, i) => { raw[k] = lists[i]; });
  return raw;
}

/**
 * Load all three tabs. Resolves to { model, source: "sheet" | "sample", error }.
 * source is "sample" when no sheet is configured or loading failed (error says why).
 */
HH.loadData = async function loadData(config) {
  const configured = Boolean(config.GOOGLE_SHEET_ID) || csvUrlsConfigured(config);
  let error = null;

  if (configured) {
    try {
      const raw = await loadFromSheet(config);
      if (!raw.spots.length) throw new Error("The Spots tab came back empty.");
      return { model: HH.buildModel(raw, config), source: "sheet", error: null };
    } catch (e) {
      error = e.message || String(e);
      if (!config.USE_SAMPLE_DATA_IF_SHEET_FAILS) throw e;
    }
  }

  const sample = window.HH_SAMPLE_CSV;
  if (!sample) throw new Error(error || "No sheet configured and no sample data found.");
  const raw = {};
  KEYS.forEach((k) => { raw[k] = HH.parseCSV(sample[k]); });
  return { model: HH.buildModel(raw, config), source: "sample", error };
};

/* ---------- turning rows into objects ---------- */

HH.buildModel = function buildModel(raw, config) {
  const C = HH.COLUMNS;
  const assumedOpen = HH.parseTime(config.ASSUMED_OPENING_TIME) ?? 11 * 60;

  const spots = new Map();
  raw.spots.forEach((row) => {
    const id = pick(row, C.spots.id);
    if (!id) return;
    const lat = toNumber(pick(row, C.spots.lat));
    const lng = toNumber(pick(row, C.spots.lng));
    spots.set(id, {
      id,
      name: pick(row, C.spots.name) || id,
      neighborhood: pick(row, C.spots.neighborhood),
      type: pick(row, C.spots.type),
      address: pick(row, C.spots.address),
      phone: pick(row, C.spots.phone),
      website: pick(row, C.spots.website),
      mapsUrl: pick(row, C.spots.mapsUrl),
      yelpUrl: pick(row, C.spots.yelpUrl),
      price: pick(row, C.spots.price),
      seating: pick(row, C.spots.seating),
      reservations: pick(row, C.spots.reservations),
      status: pick(row, C.spots.status),
      lastVerified: HH.parseDate(pick(row, C.spots.lastVerified)),
      notes: pick(row, C.spots.notes),
      lat, lng,
      hasCoords: lat !== null && lng !== null,
      schedules: [],
    });
  });

  const deals = raw.deals
    .map((row) => ({
      id: pick(row, C.deals.id),
      spotId: pick(row, C.deals.spotId),
      scheduleId: pick(row, C.deals.scheduleId),
      category: pick(row, C.deals.category) || "Other",
      item: pick(row, C.deals.item),
      price: toNumber(pick(row, C.deals.price)),
      discount: pick(row, C.deals.discount),
      notes: pick(row, C.deals.notes),
    }))
    .filter((d) => d.spotId && d.item && spots.has(d.spotId));

  const schedules = [];
  raw.schedules.forEach((row) => {
    const spotId = pick(row, C.schedules.spotId);
    const spot = spots.get(spotId);
    if (!spot) return;

    const days = HH.DAYS.map((d) => truthy(row[d]));
    const timeNote = pick(row, C.schedules.timeNote);
    const note = timeNote.toLowerCase();
    let start = HH.parseTime(pick(row, C.schedules.start));
    let end = HH.parseTime(pick(row, C.schedules.end));
    const allDay = note.includes("all day");
    const fromOpening = note.includes("opening") || allDay;
    const untilClose = note.includes("close") || allDay;
    const startAssumed = start === null && fromOpening;
    if (startAssumed) start = assumedOpen;
    if (end === null && untilClose && start !== null) end = HH.END_OF_DAY;
    if (start !== null && end !== null && end <= start) end += HH.END_OF_DAY; // crosses midnight

    const s = {
      id: pick(row, C.schedules.id),
      spot,
      label: pick(row, C.schedules.label) || "Happy hour",
      kind: pick(row, C.schedules.kind) || "Happy hour",
      days,
      hasDays: days.some(Boolean),
      start, end,
      allDay, fromOpening, untilClose, startAssumed,
      hoursKnown: start !== null && end !== null,
      timeNote,
      seating: pick(row, C.schedules.seating) || spot.seating,
      daysConfirmed: !falsy(pick(row, C.schedules.daysConfirmed)),
      notes: pick(row, C.schedules.notes),
      deals: [],
    };
    schedules.push(s);
    spot.schedules.push(s);
  });

  // Attach deals: a deal with a Schedule ID goes on that schedule; a blank one goes on
  // every regular ("Happy hour" / "Late night") window of its spot.
  const byId = new Map(schedules.map((s) => [s.id, s]));
  const isRegular = (s) => /happy hour|late night/i.test(s.kind);
  deals.forEach((d) => {
    if (d.scheduleId && byId.has(d.scheduleId)) byId.get(d.scheduleId).deals.push(d);
    else spots.get(d.spotId).schedules.filter(isRegular).forEach((s) => s.deals.push(d));
  });
  schedules.forEach((s) => {
    s.hasFood = s.deals.some((d) => /food|combo/i.test(d.category));
    s.hasDrinks = s.deals.some((d) => /drink|combo/i.test(d.category));
  });

  return { spots, schedules, deals };
};

/* ---------- status ---------- */

/**
 * Where a schedule stands on `day` given `now` ({day, minutes}).
 * Returns { state, label, sortKey }, where state is one of:
 *   "now" | "soon" | "later" | "ended" | "scheduled" (another day) | "unknown" (no hours listed)
 */
HH.statusFor = function statusFor(s, day, now, config) {
  const soonWindow = config.STARTING_SOON_MINUTES || 60;
  const isToday = day === now.day;
  const t = now.minutes;

  if (!s.hoursKnown) {
    if (isToday && s.start !== null && t < s.start) {
      return { state: "later", label: `Starts ${HH.formatTime(s.start)}`, sortKey: s.start };
    }
    return { state: "unknown", label: s.timeNote || "Hours not listed", sortKey: 9000 };
  }
  if (!isToday) return { state: "scheduled", label: "", sortKey: s.start };

  if (t < s.start) {
    const until = s.start - t;
    return until <= soonWindow
      ? { state: "soon", label: `Starts in ${HH.formatDuration(until)}`, sortKey: s.start }
      : { state: "later", label: `Starts ${HH.formatTime(s.start)}`, sortKey: s.start };
  }
  if (t < s.end) {
    const label = s.untilClose && s.end >= HH.END_OF_DAY
      ? "On now · until close"
      : `On now · ${HH.formatDuration(s.end - t)} left`;
    return { state: "now", label, sortKey: s.end };
  }
  return { state: "ended", label: "Ended", sortKey: s.start };
};

/** "4–6 PM", "11:30 AM–5:30 PM", "Open–5 PM", "9 PM–close", "All day", or the time note. */
HH.formatWindow = function formatWindow(s) {
  if (s.allDay) return "All day";
  if (s.start === null && s.end === null) return s.timeNote || "Hours not listed";
  const endIsClose = s.untilClose && s.end !== null && s.end >= HH.END_OF_DAY;
  const endTxt = s.end === null ? "" : endIsClose ? "close" : HH.formatTime(s.end);
  if (s.start === null) return `Until ${endTxt}`;
  if (s.startAssumed) return `Open–${endTxt}`;
  if (s.end === null) return `From ${HH.formatTime(s.start)}`;
  const sameHalf = !endIsClose && (s.start < 720) === ((s.end % HH.END_OF_DAY) < 720);
  return `${HH.formatTime(s.start, { suffix: !sameHalf })}–${endTxt}`;
};

/** "$7 Wine", "$2 off Appetizers", "50% off Wine bottles". */
HH.formatDeal = function formatDeal(d) {
  const price = d.price === null ? "" : `$${Number.isInteger(d.price) ? d.price : d.price.toFixed(2)}`;
  const lead = [price, d.discount].filter(Boolean).join(" · ");
  return { lead, item: d.item, notes: d.notes };
};
