/**
 * add-spot.gs — "Add a Spot" from the app. Needs menu-upload.gs in the same Apps Script project
 * (it shares the web app, the Gemini key, the photo reader and the Drive folder).
 *
 * Flow
 *   App: name (required) + optional neighborhood hint + optional menu photo → POST {action: "addSpot"}
 *   1. Duplicate check against the Spots tab.
 *   2. Gemini + Google Search looks the place up in San Diego: address, neighborhood, type, phone,
 *      website, Yelp, price level, and any published happy hour times/deals (with source links).
 *   3. If a photo was sent, Gemini reads it; for days, hours and deals the photo wins over the web.
 *   4. Apps Script's built-in geocoder (free, no key) turns the address into map coordinates.
 *   5. New rows in Spots, Schedules and Deals (+ Menu Uploads/Items if a photo), Status "Needs check".
 *
 * Setup: paste this file into the same Apps Script project as menu-upload.gs, save, then
 *   Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy. The URL stays the same.
 *   Optional Script property: MAX_NEW_SPOTS_PER_DAY (default 15).
 * Cost note: Google Search grounding includes a monthly free allowance; see
 *   https://ai.google.dev/gemini-api/docs/google-search (Pricing).
 */

const SPOTS = {
  SPOTS_TAB: "Spots", SCHEDULES_TAB: "Schedules", DEALS_TAB: "Deals",
  CITY: "San Diego, CA",
  // Rough box around greater San Diego, used to keep the geocoder local.
  BOUNDS: { south: 32.53, west: -117.35, north: 33.12, east: -116.90 },
  NEIGHBORHOODS: ["Gaslamp", "East Village", "Little Italy", "Marina", "Columbia", "Core", "Cortez Hill",
    "Embarcadero", "Seaport Village", "Bankers Hill", "Middletown", "Mission Valley", "North Park",
    "Hillcrest", "South Park", "Point Loma", "Ocean Beach", "Pacific Beach", "Mission Beach", "La Jolla", "Barrio Logan"],
};

/** Called by doPost (menu-upload.gs) when body.action === "addSpot". */
function addSpot_(body) {
  const name = String(body.name || "").replace(/\s+/g, " ").trim();
  const hint = String(body.hint || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (name.length < 2 || name.length > 80) return { ok: false, error: "Please enter the spot's name." };

  const existing = findSpotByName_(name);
  if (existing) {
    return { ok: false, duplicate: true, spotId: existing.id, error: existing.name + " is already in the app." };
  }
  const limit = addSpotRateLimit_();
  if (limit) return { ok: false, error: limit };

  // 1. Web lookup (Gemini + Google Search)
  let web = null;
  let webError = "";
  try { web = lookUpSpotWithGemini_(name, hint); } catch (err) { webError = errText_(err); }

  // 2. Optional menu photo
  let menu = null;
  let menuError = "";
  const hasPhoto = Boolean(body.image);
  if (hasPhoto) {
    const mime = String(body.mimeType || "image/jpeg");
    if (!/^image\/(jpeg|png|webp)$/.test(mime) || String(body.image).length > MENU.MAX_BASE64_CHARS) {
      return { ok: false, error: "The photo is too large or not a JPG/PNG/WebP." };
    }
    try { menu = readMenuWithGemini_(String(body.image), mime, name); } catch (err) { menuError = errText_(err); }
  }

  const found = web && web.found !== false && (web.address || web.website || web.phone);
  if (!found && !(menu && menu.is_menu !== false)) {
    return {
      ok: false,
      error: "We couldn't find \"" + name + "\" in San Diego. Check the spelling, add a neighborhood, or include a menu photo.",
      detail: webError || menuError || undefined,
    };
  }
  web = web || {};

  // 3. Map coordinates
  const geo = geocode_(web.address || [name, hint, SPOTS.CITY].filter(String).join(", "));

  // 4. Write rows
  ensureTabs_();
  const ss = SpreadsheetApp.getActive();
  const spotsSh = ss.getSheetByName(SPOTS.SPOTS_TAB);
  const spotId = nextId_(spotsSh, "Spot ID", "S", 2);
  const displayName = (web.name && similarName_(web.name, name)) ? web.name : name;
  const address = web.address || (geo && geo.address) || "";
  const neighborhood = pickNeighborhood_(web.neighborhood, geo && geo.neighborhood);
  const windows = pickWindows_(menu, web);
  const details = [menu && menu.happy_hour && menu.happy_hour.details, web.happy_hour && web.happy_hour.details]
    .filter(Boolean).join(" · ");
  const sources = (web.sources || []).slice(0, 5);
  const today = Utilities.formatDate(new Date(), "America/Los_Angeles", "yyyy-MM-dd");

  appendByHeaders_(spotsSh, function (row) {
    return {
      "Spot ID": spotId,
      "Name": displayName,
      "Neighborhood": neighborhood,
      "Type": web.type || "",
      "Address": address,
      "Phone": web.phone || "",
      "Website": cleanUrl_(web.website),
      "Google Maps link": "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(displayName + " " + address),
      "Yelp link": /yelp\.com\/biz\//.test(web.yelp_url || "") ? cleanUrl_(web.yelp_url) : "",
      "Price ($-$$$$)": /^\${1,4}$/.test(web.price || "") ? web.price : "",
      "HH seating": /bar only|bar area|at the bar|counter only|lounge only/i.test(details) ? "Bar only" : "Unknown",
      "Reservations for HH?": "Unknown",
      "Status": "Needs check",
      "Last verified": "",
      "# Schedules": "=COUNTIF(Schedules!$B:$B,A" + row + ")",
      "# Deals": "=COUNTIF(Deals!$B:$B,A" + row + ")",
      "Notes": details,
      "Details confidence": web.confidence || (found ? "Medium" : "Low"),
      "Details note": ["Added from the app on " + today + ".", hasPhoto ? "Includes a menu photo." : "",
        sources.length ? "Sources: " + sources.join(" ") : "", web.notes || ""].filter(String).join(" "),
      "Latitude": geo ? geo.lat : "",
      "Longitude": geo ? geo.lng : "",
    };
  });

  const schedSh = ss.getSheetByName(SPOTS.SCHEDULES_TAB);
  const fromPhoto = Boolean(menu && menu.happy_hour && (menu.happy_hour.windows || []).length);
  const scheduleRows = [];
  windows.forEach(function (w) {
    const id = nextId_(schedSh, "Schedule ID", "H", 3);
    const end = String(w.end_time || "").trim();
    const untilClose = /close/i.test(end);
    const startOk = parseTime12_(w.start_time);
    const endOk = untilClose ? "" : parseTime12_(end);
    const timeNote = !startOk && !endOk && !untilClose ? "Hours not listed" : untilClose ? "Until close" : "";
    appendByHeaders_(schedSh, function (row) {
      const rec = {
        "Schedule ID": id, "Spot ID": spotId,
        "Spot (auto)": '=IFERROR(INDEX(Spots!$B:$B,MATCH(B' + row + ',Spots!$A:$A,0)),"")',
        "Label": w.label || "Happy hour", "Kind": "Happy hour",
        "Start": startOk, "End": endOk, "Time note": timeNote, "Seating (if different)": "",
        "Days confirmed?": fromPhoto, "Notes": fromPhoto ? "From menu photo" : "From web search",
      };
      MENU.DAYS.forEach(function (d) { rec[d] = (w.days || []).indexOf(d) !== -1; });
      return rec;
    });
    scheduleRows.push({ id: id, label: w.label || "Happy hour", days: w.days || [], start: startOk, end: untilClose ? "close" : endOk });
  });

  const dealsSh = ss.getSheetByName(SPOTS.DEALS_TAB);
  const deals = pickDeals_(menu, web);
  deals.forEach(function (d) {
    const id = nextId_(dealsSh, "Deal ID", "D", 3);
    appendByHeaders_(dealsSh, function (row) {
      return {
        "Deal ID": id, "Spot ID": spotId,
        "Spot (auto)": '=IFERROR(INDEX(Spots!$B:$B,MATCH(B' + row + ',Spots!$A:$A,0)),"")',
        "Schedule ID": "",
        "Applies to (auto)": '=IF(D' + row + '="","All regular happy hour windows",IFERROR(INDEX(Schedules!$D:$D,MATCH(D' + row + ',Schedules!$A:$A,0)),"Check schedule ID"))',
        "Category": d.category || "Combo", "Item": d.item, "Price ($)": typeof d.price === "number" ? d.price : "",
        "Discount": d.discount || "", "Notes": d.notes || "",
      };
    });
  });

  // 5. Keep the photo as a menu upload too (shows the Menu button + dietary tags)
  let uploadId = "";
  if (hasPhoto) {
    uploadId = "U" + Utilities.formatDate(new Date(), "America/Los_Angeles", "yyyyMMdd-HHmmss") + "-" + Math.floor(Math.random() * 1000);
    const file = savePhoto_(String(body.image), String(body.mimeType || "image/jpeg"), uploadId, displayName);
    writeRows_(uploadId, { id: spotId, name: displayName }, file, menu, "Added with new spot", menuError);
  }

  return {
    ok: true, spotId: spotId,
    spot: { name: displayName, address: address, neighborhood: neighborhood, type: web.type || "", price: web.price || "" },
    schedules: scheduleRows, dealCount: deals.length, mapped: Boolean(geo), sources: sources,
    usedPhoto: Boolean(menu), photoError: menuError || undefined, webError: webError || undefined,
  };
}

/* ---------- Gemini + Google Search lookup ---------- */

const SPOT_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "true only if this specific place was found and is open." },
    name: { type: "string" }, address: { type: "string", description: "Full street address." },
    neighborhood: { type: "string" }, type: { type: "string", description: "Short, e.g. 'Wine bar', 'Taqueria'." },
    phone: { type: "string" }, website: { type: "string" }, yelp_url: { type: "string" },
    price: { type: "string", description: "$, $$, $$$ or $$$$ if a source states it." },
    happy_hour: {
      type: "object",
      properties: {
        windows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              days: { type: "array", items: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] } },
              start_time: { type: "string" }, end_time: { type: "string" },
            },
          },
        },
        details: { type: "string" },
      },
    },
    deals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["Drink", "Food", "Combo"] },
          item: { type: "string" }, price: { type: "number" }, discount: { type: "string" },
        },
      },
    },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    notes: { type: "string" },
  },
  required: ["found"],
};

function lookUpSpotWithGemini_(name, hint) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is not set in Script properties.");
  const model = props.getProperty("GEMINI_MODEL") || MENU.DEFAULT_MODEL;
  const prompt = [
    "Use Google Search to find this restaurant or bar in San Diego, California:",
    "Name: " + name + (hint ? "\nNear / neighborhood: " + hint : ""),
    "Return its details for a happy hour guide. Use only facts you found in search results;",
    "leave a field empty if no source states it. Prefer the business's own website, then Google/Yelp.",
    "- neighborhood: the San Diego neighborhood (e.g. Little Italy, Gaslamp, East Village, North Park).",
    "- happy_hour.windows: each published happy hour window (days, start_time like '3:00 PM', end_time or 'close').",
    "- deals: published happy hour deals; category Drink/Food/Combo; price in dollars if given; discount like '$2 off' or '50% off'.",
    "- found: false if you can't find this specific place, or it has permanently closed.",
    "- confidence: High if the address and happy hour come from the business's own site, Medium if from listings, Low otherwise.",
    "Respond with JSON only.",
  ].join("\n");

  const res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "x-goog-api-key": key },
    payload: JSON.stringify({
      model: model, input: prompt, tools: [{ type: "google_search" }],
      response_format: { type: "text", mime_type: "application/json", schema: SPOT_SCHEMA },
    }),
  });
  let code = res.getResponseCode();
  let text = res.getContentText();
  if (code === 400) {
    // Some models don't allow a schema together with search; ask for JSON in plain text instead.
    const res2 = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { "x-goog-api-key": key },
      payload: JSON.stringify({ model: model, input: prompt + "\nJSON keys: " + Object.keys(SPOT_SCHEMA.properties).join(", "),
        tools: [{ type: "google_search" }] }),
    });
    code = res2.getResponseCode();
    text = res2.getContentText();
  }
  if (code >= 300) throw new Error("Gemini error " + code + ": " + text.slice(0, 200));
  const resp = JSON.parse(text);
  const out = findObjectWith_(resp, "found");
  if (!out) throw new Error("Gemini returned no readable result.");
  out.sources = collectUrls_(resp).filter(function (u) { return !/vertexaisearch|googleusercontent|google\.com\/search/.test(u); });
  return out;
}

/** Find the first JSON object (as an object, or inside a string) that has `key`. */
function findObjectWith_(node, key) {
  if (node == null) return null;
  if (typeof node === "string") {
    const m = node.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { const obj = JSON.parse(m[0]); return obj && key in obj ? obj : null; } catch (e) { return null; }
  }
  if (typeof node === "object") {
    if (key in node && !("steps" in node)) return node;
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const f = findObjectWith_(node[keys[i]], key);
      if (f) return f;
    }
  }
  return null;
}

/** Citation URLs from a grounded response (url_citation annotations). */
function collectUrls_(node, acc) {
  acc = acc || [];
  if (node && typeof node === "object") {
    if (node.type === "url_citation" && node.url && acc.indexOf(node.url) === -1) acc.push(node.url);
    Object.keys(node).forEach(function (k) { collectUrls_(node[k], acc); });
  }
  return acc;
}

/* ---------- merging photo + web ---------- */

function pickWindows_(menu, web) {
  const fromMenu = menu && menu.happy_hour ? normalizeWindows_(menu.happy_hour) : [];
  if (fromMenu.length) return fromMenu;
  return web && web.happy_hour ? normalizeWindows_(web.happy_hour) : [];
}

function normalizeWindows_(hh) {
  let ws = (hh.windows || []).filter(function (w) { return (w.days || []).length || w.start_time; });
  if (!ws.length && ((hh.days || []).length || hh.start_time)) {
    ws = [{ days: hh.days || [], start_time: hh.start_time || "", end_time: hh.end_time || "", label: "Happy hour" }];
  }
  return ws.slice(0, 6);
}

function pickDeals_(menu, web) {
  const out = [];
  if (menu) {
    (menu.deals || []).forEach(function (d) { out.push(dealFrom_(d)); });
    (menu.items || []).forEach(function (it) {
      if (it.happy_hour && it.name && (typeof it.price === "number" || it.price_text)) {
        out.push({ category: it.category || "Food", item: it.name, price: it.price, notes: it.price_text && typeof it.price !== "number" ? it.price_text : "" });
      }
    });
  }
  if (!out.length && web) (web.deals || []).forEach(function (d) { out.push(dealFrom_(d)); });
  return out.filter(function (d) { return d.item; }).slice(0, 40);
}

function dealFrom_(d) {
  if (typeof d === "string") return { category: "Combo", item: d };
  return { category: d.category || "Combo", item: d.item || d.description || "", price: d.price, discount: d.discount || "",
    notes: d.item && d.description && d.description !== d.item ? d.description : "" };
}

/* ---------- geocoding (Apps Script built-in, no key) ---------- */

function geocode_(query) {
  try {
    const b = SPOTS.BOUNDS;
    const res = Maps.newGeocoder().setRegion("us").setBounds(b.south, b.west, b.north, b.east).geocode(query);
    const r = res && res.results && res.results[0];
    if (!r) return null;
    const loc = r.geometry.location;
    if (loc.lat < b.south || loc.lat > b.north || loc.lng < b.west || loc.lng > b.east) return null;
    const hood = (r.address_components || []).filter(function (c) { return c.types.indexOf("neighborhood") !== -1; })[0];
    return { lat: Number(loc.lat.toFixed(6)), lng: Number(loc.lng.toFixed(6)), address: r.formatted_address, neighborhood: hood ? hood.long_name : "" };
  } catch (e) {
    return null;
  }
}

/* ---------- sheet helpers ---------- */

/** Append one row, filling columns by header name. build(rowNumber) returns {header: value}. */
function appendByHeaders_(sheet, build) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const row = lastDataRow_(sheet) + 1;
  const rec = build(row);
  sheet.getRange(row, 1, 1, headers.length).setValues([headers.map(function (h) { return h in rec ? rec[h] : ""; })]);
  return row;
}

/** Last row with a value in column A (ignores formatted-but-empty rows at the bottom). */
function lastDataRow_(sheet) {
  const n = sheet.getLastRow();
  if (n < 2) return 1;
  const col = sheet.getRange(1, 1, n, 1).getValues();
  for (let i = col.length - 1; i >= 0; i--) if (String(col[i][0]).trim() !== "") return i + 1;
  return 1;
}

/** Next ID like S36 / H060 / D125 based on the highest existing one in that column. */
function nextId_(sheet, header, prefix, pad) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const col = headers.indexOf(header) + 1;
  let max = 0;
  if (col && sheet.getLastRow() > 1) {
    sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      const m = String(r[0]).match(new RegExp("^" + prefix + "(\\d+)$"));
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  return prefix + String(max + 1).padStart(pad, "0");
}

function findSpotByName_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SPOTS.SPOTS_TAB);
  if (!sh || sh.getLastRow() < 2) return null;
  const values = sh.getDataRange().getValues();
  const head = values[0].map(function (h) { return String(h).trim(); });
  const idCol = head.indexOf("Spot ID");
  const nameCol = head.indexOf("Name");
  for (let r = 1; r < values.length; r++) {
    const existing = String(values[r][nameCol]);
    if (existing && similarName_(existing, name)) return { id: String(values[r][idCol]), name: existing };
  }
  return null;
}

/** "The Lion's Share" ≈ "lions share"; "Postino" ≈ "Postino Little Italy". */
function similarName_(a, b) {
  const norm = function (s) {
    return String(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, "")
      .replace(/\b(the|bar|and|grill|restaurant|kitchen|sd|san diego)\b/g, " ").replace(/\s+/g, " ").trim();
  };
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 5 && y.indexOf(x) === 0) || (y.length >= 5 && x.indexOf(y) === 0);
}

function pickNeighborhood_(fromWeb, fromGeo) {
  const list = SPOTS.NEIGHBORHOODS;
  const match = function (s) {
    s = String(s || "").toLowerCase();
    if (!s) return "";
    if (/gaslamp/.test(s)) return "Gaslamp";
    for (let i = 0; i < list.length; i++) if (s.indexOf(list[i].toLowerCase()) !== -1) return list[i];
    return "";
  };
  return match(fromWeb) || match(fromGeo) || String(fromWeb || fromGeo || "").trim();
}

/** "3 PM" / "3:00 pm" / "15:00" → "3:00 PM"; anything else → "". */
function parseTime12_(s) {
  const m = String(s || "").trim().toUpperCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A|P)?$/);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2] || "00";
  let ap = m[3] ? (m[3].charAt(0) === "P" ? "PM" : "AM") : "";
  if (!ap) { ap = h >= 12 ? "PM" : (h <= 6 ? "PM" : "AM"); if (h > 12) h -= 12; } // bare "4" → 4 PM
  if (h === 0) h = 12;
  if (h > 12 || Number(min) > 59) return "";
  return h + ":" + min + " " + ap;
}

function cleanUrl_(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return /^https?:\/\/[^\s]+\.[^\s]+/.test(u) ? u : "";
}

function addSpotRateLimit_() {
  const perDay = Number(PropertiesService.getScriptProperties().getProperty("MAX_NEW_SPOTS_PER_DAY") || 15);
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const k = "newspot-" + Utilities.formatDate(new Date(), "America/Los_Angeles", "yyyyMMdd");
    const n = Number(cache.get(k) || 0);
    if (n >= perDay) return "We've hit today's limit for new spots. Please try again tomorrow.";
    cache.put(k, String(n + 1), 6 * 60 * 60);
    return "";
  } finally {
    lock.releaseLock();
  }
}

function errText_(err) {
  return String(err && err.message ? err.message : err).slice(0, 300);
}
