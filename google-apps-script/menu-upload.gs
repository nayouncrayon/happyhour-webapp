/**
 * menu-upload.gs — receives menu photos from the app, reads them with Gemini, and queues the
 * results in the sheet. By default a photo Gemini recognizes as a menu goes live right away
 * (Status = Approved); anything else waits as Pending. Set AUTO_APPROVE = false to review everything.
 *
 * Flow
 *   App (anyone) → POST photo to this web app → photo saved to your Google Drive →
 *   Gemini reads it → one row in "Menu Uploads" + one row per item in "Menu Items"
 *   → Status Approved (auto) → the app shows the dietary tags and the menu photo.
 *   To take one down: set its Status to Rejected (or untick Show? on a single item).
 *
 * One-time setup (about 5 minutes)
 *   1. Get a free Gemini API key: https://aistudio.google.com/apikey
 *   2. In the sheet: Extensions → Apps Script → add a file (+ → Script) named menu-upload, paste this file.
 *   3. Project Settings (gear icon) → Script properties → Add property:
 *        GEMINI_API_KEY = your key
 *      Optional: GEMINI_MODEL (default below; see https://ai.google.dev/gemini-api/docs/models),
 *                MAX_UPLOADS_PER_DAY (default 40; counted in rolling ~6-hour windows),
 *                MAX_UPLOADS_PER_SPOT_PER_HOUR (default 3),
 *                AUTO_APPROVE (default true; set to false to review every upload first).
 *   4. Back in the editor, pick the function "setupMenuUploads" in the toolbar and click Run.
 *      Google asks for permission (Sheets, Drive, external requests). This also creates the tabs.
 *   5. Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 *      Copy the Web app URL into MENU_UPLOAD_URL in js/config.js.
 *   After editing this file later: Deploy → Manage deployments → edit → Version: New version.
 *
 * Privacy/abuse notes
 *   - Your API key stays here (Script properties); it is never sent to the browser.
 *   - Uploads are rate-limited. Photos that don't look like a menu, or that Gemini couldn't read,
 *     stay Pending for you to check.
 *   - Photos are saved in Drive as "anyone with the link can view" so the app can show approved ones.
 */

const MENU = {
  UPLOADS_TAB: "Menu Uploads",
  ITEMS_TAB: "Menu Items",
  SPOTS_TAB: "Spots",
  DRIVE_FOLDER: "Happy Hour Menu Photos",
  DEFAULT_MODEL: "gemini-3.6-flash",
  MAX_BASE64_CHARS: 8 * 1024 * 1024, // ~6 MB image
  UPLOAD_HEADERS: [
    "Upload ID", "Spot ID", "Spot name", "Submitted", "Status", "Photo URL", "Photo file ID",
    "HH days (read)", "HH start (read)", "HH end (read)", "HH details (read)", "Deals (read)",
    "Item count", "Note from uploader", "AI notes", "Raw JSON",
  ],
  ITEM_HEADERS: [
    "Upload ID", "Spot ID", "Section", "Item", "Description", "Price ($)", "Price text",
    "Happy hour item?", "Dietary", "Show?",
  ],
  STATUSES: ["Pending", "Approved", "Rejected"],
  DIETARY: ["Vegetarian", "Vegan", "Gluten-free", "Dairy-free", "Nut-free", "Spicy"],
  DAYS: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};

/* ---------- web app entry points ---------- */

function doGet() {
  return json_({ ok: true, service: "happy-hour-menu-upload" });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (body.website) return json_({ ok: true, ignored: true }); // honeypot field filled = bot

    const spotId = String(body.spotId || "").trim();
    const image = String(body.image || "");
    const mime = String(body.mimeType || "image/jpeg");
    const note = String(body.note || "").slice(0, 500);
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return json_({ ok: false, error: "Please upload a JPG, PNG or WebP photo." });
    if (!image || image.length > MENU.MAX_BASE64_CHARS) return json_({ ok: false, error: "The photo is missing or too large." });

    const spot = findSpot_(spotId);
    if (!spot) return json_({ ok: false, error: "Unknown spot." });

    const limit = checkRateLimit_(spotId);
    if (limit) return json_({ ok: false, error: limit });

    ensureTabs_();
    const uploadId = "U" + Utilities.formatDate(new Date(), "America/Los_Angeles", "yyyyMMdd-HHmmss") +
      "-" + Math.floor(Math.random() * 1000);

    const file = savePhoto_(image, mime, uploadId, spot.name);
    let parsed = null;
    let aiError = "";
    try {
      parsed = readMenuWithGemini_(image, mime, spot.name);
    } catch (err) {
      aiError = String(err && err.message ? err.message : err).slice(0, 300);
    }

    writeRows_(uploadId, spot, file, parsed, note, aiError);
    return json_({
      ok: true, uploadId: uploadId, status: statusFor_(parsed),
      summary: summarize_(parsed), aiError: aiError || undefined,
    });
  } catch (err) {
    return json_({ ok: false, error: "Something went wrong: " + String(err && err.message ? err.message : err) });
  }
}

/** Run once from the editor: authorizes the script and creates the two tabs + Drive folder. */
function setupMenuUploads() {
  ensureTabs_();
  driveFolder_();
  const key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  Logger.log(key ? "Ready. Now deploy as a web app." : "Tabs created. Add GEMINI_API_KEY in Project Settings → Script properties.");
}

/* ---------- Gemini ---------- */

const MENU_PROMPT = [
  "You are reading a photo of a restaurant or bar menu for a happy hour guide in San Diego.",
  "Extract only what is visibly written on the menu. Never guess or invent items, prices, days or times.",
  "- happy_hour: the days and hours of happy hour if printed, plus other conditions",
  "  (bar only, dine-in only, exclusions, holidays). Leave fields empty if not shown.",
  "- deals: blanket deal rules, written as short phrases, e.g. \"1/2 off all appetizers\", \"$2 off draft beers\".",
  "- items: every menu item with its section heading, description and price exactly as shown.",
  "  Set happy_hour true for items on a happy hour menu or marked as happy hour.",
  "- dietary: only tag an item when the menu marks it (e.g. V, VG, GF symbols with a legend) or the",
  "  description states it plainly (e.g. \"vegan\", \"gluten-free\"). Do not infer from ingredients.",
  "  People with allergies may rely on this, so when unsure, leave it empty.",
  "- is_menu: false if the photo is not a menu.",
  "- notes: anything unclear, cut off or hard to read.",
].join("\n");

const MENU_SCHEMA = {
  type: "object",
  properties: {
    is_menu: { type: "boolean" },
    happy_hour: {
      type: "object",
      properties: {
        days: { type: "array", items: { type: "string", enum: MENU.DAYS } },
        start_time: { type: "string", description: "e.g. 3:00 PM. Empty if not shown." },
        end_time: { type: "string", description: "e.g. 6:00 PM, or 'close'. Empty if not shown." },
        details: { type: "string" },
      },
    },
    deals: { type: "array", items: { type: "string" } },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          section: { type: "string" },
          description: { type: "string" },
          price: { type: "number", description: "Numeric price in dollars if a single price is shown." },
          price_text: { type: "string", description: "Price exactly as printed, e.g. '$8 / $12'." },
          happy_hour: { type: "boolean" },
          dietary: { type: "array", items: { type: "string", enum: MENU.DIETARY } },
        },
        required: ["name"],
      },
    },
    notes: { type: "string" },
  },
  required: ["is_menu", "deals", "items"],
};

function readMenuWithGemini_(base64, mime, spotName) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is not set in Script properties.");
  const model = props.getProperty("GEMINI_MODEL") || MENU.DEFAULT_MODEL;
  const prompt = MENU_PROMPT + "\nThe spot is: " + spotName + ".";

  // Current Gemini "Interactions" API first; fall back to the older generateContent API.
  let res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "x-goog-api-key": key },
    payload: JSON.stringify({
      model: model,
      input: [{ type: "text", text: prompt }, { type: "image", data: base64, mime_type: mime }],
      response_format: { type: "text", mime_type: "application/json", schema: MENU_SCHEMA },
    }),
  });
  if (res.getResponseCode() === 404 || res.getResponseCode() === 400) {
    res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent", {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { "x-goog-api-key": key },
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: MENU_SCHEMA },
      }),
    });
  }
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error("Gemini error " + code + ": " + text.slice(0, 200));
  const parsed = findJson_(JSON.parse(text));
  if (!parsed) throw new Error("Gemini returned no readable result.");
  return parsed;
}

/** Find the model's JSON answer anywhere in the API response (formats differ between APIs). */
function findJson_(node) {
  if (node == null) return null;
  if (typeof node === "string") {
    const s = node.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    if (s.charAt(0) !== "{") return null;
    try { const obj = JSON.parse(s); return obj && Array.isArray(obj.items) ? obj : null; } catch (e) { return null; }
  }
  if (typeof node === "object") {
    if (Array.isArray(node.items) && Array.isArray(node.deals)) return node;
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const found = findJson_(node[keys[i]]);
      if (found) return found;
    }
  }
  return null;
}

/* ---------- sheet + drive ---------- */

function ensureTabs_() {
  const ss = SpreadsheetApp.getActive();
  [[MENU.UPLOADS_TAB, MENU.UPLOAD_HEADERS], [MENU.ITEMS_TAB, MENU.ITEM_HEADERS]].forEach(function (pair) {
    let sh = ss.getSheetByName(pair[0]);
    if (!sh) {
      sh = ss.insertSheet(pair[0]);
      sh.getRange(1, 1, 1, pair[1].length).setValues([pair[1]]).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
  });
  const up = ss.getSheetByName(MENU.UPLOADS_TAB);
  const statusCol = MENU.UPLOAD_HEADERS.indexOf("Status") + 1;
  up.getRange(2, statusCol, 999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(MENU.STATUSES, true).build());
  const items = ss.getSheetByName(MENU.ITEMS_TAB);
  const showCol = MENU.ITEM_HEADERS.indexOf("Show?") + 1;
  items.getRange(2, showCol, 4999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

function driveFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("MENU_FOLDER_ID");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  const folder = DriveApp.createFolder(MENU.DRIVE_FOLDER);
  props.setProperty("MENU_FOLDER_ID", folder.getId());
  return folder;
}

function savePhoto_(base64, mime, uploadId, spotName) {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, uploadId + " " + spotName + "." + ext);
  const file = driveFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: file.getId(), url: "https://drive.google.com/file/d/" + file.getId() + "/view" };
}

function findSpot_(spotId) {
  if (!spotId) return null;
  const sh = SpreadsheetApp.getActive().getSheetByName(MENU.SPOTS_TAB);
  if (!sh || sh.getLastRow() < 2) return null;
  const values = sh.getDataRange().getValues();
  const head = values[0].map(function (h) { return String(h).trim(); });
  const idCol = head.indexOf("Spot ID");
  const nameCol = head.indexOf("Name");
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]).trim() === spotId) return { id: spotId, name: String(values[r][nameCol]) };
  }
  return null;
}

function writeRows_(uploadId, spot, file, parsed, note, aiError) {
  const ss = SpreadsheetApp.getActive();
  const hh = (parsed && parsed.happy_hour) || {};
  const items = (parsed && parsed.items) || [];
  const aiNotes = [
    parsed && parsed.is_menu === false ? "This may not be a menu." : "",
    (parsed && parsed.notes) || "",
    aiError ? "Could not read automatically: " + aiError : "",
  ].filter(String).join(" ");

  ss.getSheetByName(MENU.UPLOADS_TAB).appendRow([
    uploadId, spot.id, spot.name, new Date(), statusFor_(parsed), file.url, file.id,
    (hh.days || []).join(" "), hh.start_time || "", hh.end_time || "", hh.details || "",
    ((parsed && parsed.deals) || []).join("; "), items.length, note, aiNotes,
    parsed ? JSON.stringify(parsed).slice(0, 45000) : "",
  ]);

  if (items.length) {
    const rows = items.map(function (it) {
      return [
        uploadId, spot.id, it.section || "", it.name || "", it.description || "",
        typeof it.price === "number" ? it.price : "", it.price_text || "",
        it.happy_hour === true, (it.dietary || []).join(", "), true,
      ];
    });
    const sh = ss.getSheetByName(MENU.ITEMS_TAB);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

/** Auto-approve readable menus unless AUTO_APPROVE is set to "false". Everything else waits as Pending. */
function statusFor_(parsed) {
  const auto = String(PropertiesService.getScriptProperties().getProperty("AUTO_APPROVE") || "true").toLowerCase() !== "false";
  return auto && parsed && parsed.is_menu !== false ? "Approved" : "Pending";
}

function summarize_(parsed) {
  if (!parsed) return null;
  const hh = parsed.happy_hour || {};
  const counts = {};
  (parsed.items || []).forEach(function (it) {
    (it.dietary || []).forEach(function (d) { counts[d] = (counts[d] || 0) + 1; });
  });
  return {
    isMenu: parsed.is_menu !== false,
    days: hh.days || [], start: hh.start_time || "", end: hh.end_time || "", details: hh.details || "",
    deals: parsed.deals || [], itemCount: (parsed.items || []).length, dietary: counts,
  };
}

/* ---------- rate limiting ---------- */

function checkRateLimit_(spotId) {
  const props = PropertiesService.getScriptProperties();
  const perDay = Number(props.getProperty("MAX_UPLOADS_PER_DAY") || 40);
  const perSpot = Number(props.getProperty("MAX_UPLOADS_PER_SPOT_PER_HOUR") || 3);
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const dayKey = "day-" + Utilities.formatDate(new Date(), "America/Los_Angeles", "yyyyMMdd");
    const spotKey = "spot-" + spotId + "-" + Utilities.formatDate(new Date(), "America/Los_Angeles", "yyyyMMddHH");
    const day = Number(cache.get(dayKey) || 0);
    const spot = Number(cache.get(spotKey) || 0);
    if (day >= perDay) return "We've hit today's upload limit. Please try again tomorrow.";
    if (spot >= perSpot) return "This spot just got a few uploads. Please try again in an hour.";
    cache.put(dayKey, String(day + 1), 6 * 60 * 60);
    cache.put(spotKey, String(spot + 1), 60 * 60);
    return "";
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
