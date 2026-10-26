/**
 * group-pick.gs — backend for "Group Pick": friends share a link, each says when they can get
 * there and what they'd like, and the app recommends the spot that suits the group best.
 * Needs menu-upload.gs in the same Apps Script project (it shares the web app and json_()).
 *
 * What lives here: the groups and each member's preferences. The ranking itself runs in the
 * app (js/group.js), against the same spots the main list loads.
 *
 * Tabs (created automatically on first use, or by running setupGroupPick once):
 *   Groups         one row per group:  Group ID, Name, Date, Organizer member ID, Created, Locked spot ID, Locked at
 *   Group Members  one row per person: Group ID, Member ID, Name, Token hash, Arrive by, Prefs, Joined, Updated
 *
 * No logins. Creating or joining a group returns a random token that stays on that phone; only
 * its SHA-256 hash is stored, so the (link-shared) sheet never shows anything that lets someone
 * edit another person's preferences. Only the organizer can change the day or lock in a spot.
 *
 * Setup: paste this file into the same Apps Script project as menu-upload.gs (+ → Script →
 *   "group-pick"), save, then Deploy → Manage deployments → edit (pencil) → Version: New version
 *   → Deploy. The web app URL stays the same. Optional Script property: MAX_GROUPS_PER_DAY (default 60).
 */

const GROUPS = {
  GROUPS_TAB: "Groups",
  MEMBERS_TAB: "Group Members",
  GROUP_HEADERS: ["Group ID", "Name", "Date", "Organizer member ID", "Created", "Locked spot ID", "Locked at"],
  MEMBER_HEADERS: ["Group ID", "Member ID", "Name", "Token hash", "Arrive by", "Prefs", "Joined", "Updated"],
  MAX_MEMBERS: 20,
  CODE_CHARS: "ABCDEFGHJKMNPQRSTUVWXYZ23456789",
  PRICES: ["$", "$$", "$$$"],
  DRINKS: ["Beer", "Wine", "Cocktails", "Non-alcoholic"],
  VIBES: ["Dive bar", "Wine bar", "Brewpub", "Cocktail bar", "Restaurant", "Rooftop"],
};

/** Optional: run once from the editor to create both tabs up front. */
function setupGroupPick() {
  groupTab_(GROUPS.GROUPS_TAB, GROUPS.GROUP_HEADERS);
  groupTab_(GROUPS.MEMBERS_TAB, GROUPS.MEMBER_HEADERS);
}

/** Entry point, called from doPost in menu-upload.gs for any action starting with "group". */
function groupPick_(body) {
  const action = String(body.action || "");
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return { ok: false, error: "The server is busy. Please try again." }; }
  try {
    switch (action) {
      case "groupCreate": return groupCreate_(body);
      case "groupJoin": return groupJoin_(body);
      case "groupGet": return groupGet_(body);
      case "groupSave": return groupSave_(body);
      case "groupUpdate": return groupUpdate_(body);
      case "groupLock": return groupLock_(body);
      default: return { ok: false, error: "Unknown action." };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- actions ---------- */

function groupCreate_(body) {
  const name = gText_(body.name, 60) || "Happy hour";
  const date = gDate_(body.date);
  const person = gText_(body.memberName, 40);
  if (!date) return { ok: false, error: "Pick a day." };
  if (!person) return { ok: false, error: "Add your name." };

  const groups = groupTab_(GROUPS.GROUPS_TAB, GROUPS.GROUP_HEADERS);
  const rows = gRows_(groups);
  const max = Number(PropertiesService.getScriptProperties().getProperty("MAX_GROUPS_PER_DAY")) || 60;
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const createdToday = rows.filter((r) => r.Created instanceof Date &&
    Utilities.formatDate(r.Created, Session.getScriptTimeZone(), "yyyy-MM-dd") === today).length;
  if (createdToday >= max) return { ok: false, error: "Lots of groups were started today. Please try again tomorrow." };

  const taken = new Set(rows.map((r) => String(r["Group ID"])));
  let code;
  do { code = gCode_(6); } while (taken.has(code));

  const memberId = "M" + gCode_(8);
  const token = Utilities.getUuid();
  const now = new Date();
  gAppend_(groups, [code, name, date, memberId, now, "", ""], [true, true, true, true, false, true, false]);
  const members = groupTab_(GROUPS.MEMBERS_TAB, GROUPS.MEMBER_HEADERS);
  gAppend_(members, [code, memberId, person, gHash_(token), "", "", now, now], [true, true, true, true, true, true, false, false]);
  return Object.assign(groupState_(code), { memberId, token });
}

function groupJoin_(body) {
  const code = gGroupId_(body.groupId);
  const person = gText_(body.memberName, 40);
  if (!person) return { ok: false, error: "Add your name." };
  const group = gFindGroup_(code);
  if (!group) return { ok: false, error: "This group link isn't valid anymore." };

  const members = groupTab_(GROUPS.MEMBERS_TAB, GROUPS.MEMBER_HEADERS);
  const count = gRows_(members).filter((r) => String(r["Group ID"]) === code).length;
  if (count >= GROUPS.MAX_MEMBERS) return { ok: false, error: "This group is full." };

  const memberId = "M" + gCode_(8);
  const token = Utilities.getUuid();
  const now = new Date();
  gAppend_(members, [code, memberId, person, gHash_(token), "", "", now, now], [true, true, true, true, true, true, false, false]);
  return Object.assign(groupState_(code), { memberId, token });
}

function groupGet_(body) {
  const code = gGroupId_(body.groupId);
  if (!gFindGroup_(code)) return { ok: false, error: "This group link isn't valid anymore." };
  return groupState_(code);
}

function groupSave_(body) {
  const me = gAuth_(body);
  if (!me) return { ok: false, error: "We couldn't confirm it's you. Open the group link on the phone you joined with." };
  const arrive = gArrive_(body.arrive);
  if (arrive === null) return { ok: false, error: "Pick when you can get there." };
  const prefs = gPrefs_(body.prefs);
  const name = gText_(body.memberName, 40);
  const sheet = me.sheet;
  const cols = gCols_(sheet);
  if (name) sheet.getRange(me.row, cols["Name"]).setValue(name);
  sheet.getRange(me.row, cols["Arrive by"]).setNumberFormat("@").setValue(arrive);
  sheet.getRange(me.row, cols["Prefs"]).setNumberFormat("@").setValue(JSON.stringify(prefs));
  sheet.getRange(me.row, cols["Updated"]).setValue(new Date());
  return groupState_(me.groupId);
}

/** Organizer only: change the name or day. */
function groupUpdate_(body) {
  const me = gAuth_(body);
  const group = me && gFindGroup_(me.groupId);
  if (!group || group.organizerId !== me.memberId) return { ok: false, error: "Only the organizer can change this." };
  const cols = gCols_(group.sheet);
  if (body.date !== undefined) {
    const date = gDate_(body.date);
    if (!date) return { ok: false, error: "Pick a day." };
    group.sheet.getRange(group.row, cols["Date"]).setNumberFormat("@").setValue(date);
    // A new day means a new pick.
    group.sheet.getRange(group.row, cols["Locked spot ID"]).setValue("");
    group.sheet.getRange(group.row, cols["Locked at"]).setValue("");
  }
  if (body.name !== undefined) {
    const name = gText_(body.name, 60);
    if (name) group.sheet.getRange(group.row, cols["Name"]).setNumberFormat("@").setValue(name);
  }
  return groupState_(me.groupId);
}

/** Organizer only: lock in a spot (spotId) or clear it (empty spotId). */
function groupLock_(body) {
  const me = gAuth_(body);
  const group = me && gFindGroup_(me.groupId);
  if (!group || group.organizerId !== me.memberId) return { ok: false, error: "Only the organizer can lock in a spot." };
  const spotId = String(body.spotId || "").trim();
  if (spotId && !/^[\w-]{1,20}$/.test(spotId)) return { ok: false, error: "Unknown spot." };
  const cols = gCols_(group.sheet);
  group.sheet.getRange(group.row, cols["Locked spot ID"]).setNumberFormat("@").setValue(spotId);
  group.sheet.getRange(group.row, cols["Locked at"]).setValue(spotId ? new Date() : "");
  return groupState_(me.groupId);
}

/** Everything the app needs about a group. Token hashes never leave the sheet. */
function groupState_(code) {
  const g = gFindGroup_(code);
  const members = gRows_(groupTab_(GROUPS.MEMBERS_TAB, GROUPS.MEMBER_HEADERS))
    .filter((r) => String(r["Group ID"]) === code)
    .map((r) => {
      let prefs = {};
      try { prefs = JSON.parse(String(r["Prefs"] || "{}")) || {}; } catch (e) { prefs = {}; }
      const arrive = gArrive_(r["Arrive by"]);
      return { id: String(r["Member ID"]), name: String(r["Name"]), arrive, prefs, ready: arrive !== null };
    });
  return {
    ok: true,
    group: { id: g.id, name: g.name, date: g.date, organizerId: g.organizerId, lockedSpotId: g.lockedSpotId },
    members,
  };
}

/* ---------- sheet helpers ---------- */

function groupTab_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function gCols_(sheet) {
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const cols = {};
  head.forEach((h, i) => { cols[String(h).trim()] = i + 1; });
  return cols;
}

function gRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
  const head = values[0].map((h) => String(h).trim());
  return values.slice(1).map((v, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[h] = v[j]; });
    return o;
  });
}

/** Append a row; columns flagged true are stored as plain text so Sheets doesn't turn "2026-10-30" into a date. */
function gAppend_(sheet, values, asText) {
  const row = sheet.getLastRow() + 1;
  values.forEach((_, i) => { if (asText[i]) sheet.getRange(row, i + 1).setNumberFormat("@"); });
  sheet.getRange(row, 1, 1, values.length).setValues([values.map((v) => (v instanceof Date ? v : String(v)))]);
}

function gFindGroup_(code) {
  if (!code) return null;
  const sheet = groupTab_(GROUPS.GROUPS_TAB, GROUPS.GROUP_HEADERS);
  const r = gRows_(sheet).find((x) => String(x["Group ID"]) === code);
  if (!r) return null;
  const date = r["Date"] instanceof Date
    ? Utilities.formatDate(r["Date"], Session.getScriptTimeZone(), "yyyy-MM-dd")
    : String(r["Date"]);
  return {
    sheet, row: r._row, id: code, name: String(r["Name"]), date,
    organizerId: String(r["Organizer member ID"]), lockedSpotId: String(r["Locked spot ID"] || ""),
  };
}

function gAuth_(body) {
  const code = gGroupId_(body.groupId);
  const memberId = String(body.memberId || "");
  const token = String(body.token || "");
  if (!code || !memberId || !token) return null;
  const sheet = groupTab_(GROUPS.MEMBERS_TAB, GROUPS.MEMBER_HEADERS);
  const r = gRows_(sheet).find((x) => String(x["Group ID"]) === code && String(x["Member ID"]) === memberId);
  if (!r || String(r["Token hash"]) !== gHash_(token)) return null;
  return { sheet, row: r._row, groupId: code, memberId };
}

/* ---------- value cleaners ---------- */

function gText_(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max); }
function gGroupId_(v) { const s = String(v || "").trim().toUpperCase(); return /^[A-Z0-9]{4,10}$/.test(s) ? s : ""; }
function gDate_(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(s + "T12:00:00");
  return isNaN(d) ? "" : s;
}
/** Minutes after midnight (e.g. 990 = 4:30 PM), or null. */
function gArrive_(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 1440 ? n : null;
}
function gList_(v, allowed, max) {
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach((x) => {
    const s = gText_(x, 40);
    if (s && (!allowed || allowed.indexOf(s) >= 0) && out.indexOf(s) < 0) out.push(s);
  });
  return out.slice(0, max);
}
function gPrefs_(p) {
  p = p && typeof p === "object" ? p : {};
  return {
    hoods: gList_(p.hoods, null, 12),
    price: gList_(p.price, GROUPS.PRICES, 3),
    food: p.food === true,
    drinks: gList_(p.drinks, GROUPS.DRINKS, 4),
    table: p.table === true,
    vibe: gList_(p.vibe, GROUPS.VIBES, 6),
    skip: gList_(p.skip, null, 20).filter((id) => /^[\w-]{1,20}$/.test(id)),
  };
}
function gCode_(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += GROUPS.CODE_CHARS.charAt(Math.floor(Math.random() * GROUPS.CODE_CHARS.length));
  return s;
}
function gHash_(token) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8));
}
