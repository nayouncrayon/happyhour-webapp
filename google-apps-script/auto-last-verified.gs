/**
 * auto-last-verified.gs — Google Apps Script for the "Downtown SD Happy Hours" sheet.
 *
 * What it does
 *   1. Whenever you edit a spot's row on the Spots tab, or one of its rows on the Schedules
 *      or Deals tab, it sets that spot's "Last verified" date (Spots tab) to today.
 *   2. Adds a "Happy Hour" menu with "Mark selected spots verified today", for when you
 *      checked a spot and nothing changed (so there was nothing to edit).
 *
 * Install (one time, about 2 minutes)
 *   1. In the Google Sheet: Extensions → Apps Script.
 *   2. Delete any code in the editor, paste this whole file, click Save (disk icon).
 *   3. Reload the sheet. The "Happy Hour" menu appears; the first time you use it, Google
 *      asks you to authorize the script (it only touches this spreadsheet).
 *   No triggers to set up: onEdit and onOpen are "simple triggers" that run automatically.
 *
 * Notes
 *   - Columns are found by header name, so you can reorder columns freely.
 *   - Edits to helper columns (listed in IGNORE_HEADERS) don't count as a verification.
 *   - Simple triggers only fire for edits made by a person in the sheet, not for edits
 *     made by other scripts or imports.
 */

const SETTINGS = {
  SPOTS_TAB: "Spots",
  SCHEDULES_TAB: "Schedules",
  DEALS_TAB: "Deals",
  SPOT_ID_HEADER: "Spot ID",
  LAST_VERIFIED_HEADER: "Last verified",
  DATE_FORMAT: "yyyy-mm-dd",
  // Editing only these columns does NOT update Last verified.
  IGNORE_HEADERS: [
    "Last verified", "# Schedules", "# Deals", "Spot (auto)", "Applies to (auto)",
    "Details confidence", "Details note",
  ],
};

/** Runs automatically on every manual edit. */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const tab = sheet.getName();

  // Approving a menu upload (Menu Uploads → Status = Approved) also counts as verifying that spot.
  if (tab === "Menu Uploads") {
    const h = headersOf_(sheet);
    const statusCol = h.indexOf("Status") + 1;
    if (statusCol && e.range.getColumn() <= statusCol && e.range.getLastColumn() >= statusCol &&
        String(e.value || "").trim() === "Approved") {
      const spotId = String(sheet.getRange(e.range.getRow(), h.indexOf(SETTINGS.SPOT_ID_HEADER) + 1).getValue()).trim();
      if (spotId) stampSpots_([spotId]);
    }
    return;
  }
  if ([SETTINGS.SPOTS_TAB, SETTINGS.SCHEDULES_TAB, SETTINGS.DEALS_TAB].indexOf(tab) === -1) return;

  const headers = headersOf_(sheet);
  const editedHeaders = headers.slice(e.range.getColumn() - 1, e.range.getLastColumn());
  const countsAsUpdate = editedHeaders.some(function (h) {
    return h && SETTINGS.IGNORE_HEADERS.indexOf(h) === -1;
  });
  if (!countsAsUpdate) return;

  const firstRow = Math.max(2, e.range.getRow()); // row 1 is the header
  const lastRow = e.range.getLastRow();
  if (lastRow < firstRow) return;

  const idCol = headers.indexOf(SETTINGS.SPOT_ID_HEADER) + 1;
  if (!idCol) return;
  const ids = sheet.getRange(firstRow, idCol, lastRow - firstRow + 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(String);
  stampSpots_(ids);
}

/** Adds the "Happy Hour" menu when the sheet opens. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Happy Hour")
    .addItem("Mark selected spots verified today", "markSelectedVerified")
    .addToUi();
}

/** Menu action: stamp today on the spots in the selected rows (any of the three tabs). */
function markSelectedVerified() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getActiveRange();
  const idCol = headersOf_(sheet).indexOf(SETTINGS.SPOT_ID_HEADER) + 1;
  if (!range || !idCol) {
    SpreadsheetApp.getUi().alert('Select rows on the Spots, Schedules or Deals tab first.');
    return;
  }
  const firstRow = Math.max(2, range.getRow());
  const lastRow = range.getLastRow();
  if (lastRow < firstRow) return;
  const ids = sheet.getRange(firstRow, idCol, lastRow - firstRow + 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(String);
  const count = stampSpots_(ids);
  SpreadsheetApp.getActive().toast(count + " spot(s) marked verified today.", "Happy Hour");
}

/** Set Last verified = today for the given Spot IDs. Returns how many rows were stamped. */
function stampSpots_(spotIds) {
  if (!spotIds.length) return 0;
  const wanted = {};
  spotIds.forEach(function (id) { wanted[id] = true; });

  const spots = SpreadsheetApp.getActive().getSheetByName(SETTINGS.SPOTS_TAB);
  if (!spots || spots.getLastRow() < 2) return 0;
  const headers = headersOf_(spots);
  const idCol = headers.indexOf(SETTINGS.SPOT_ID_HEADER) + 1;
  const lvCol = headers.indexOf(SETTINGS.LAST_VERIFIED_HEADER) + 1;
  if (!idCol || !lvCol) return 0;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ids = spots.getRange(2, idCol, spots.getLastRow() - 1, 1).getValues();
  let count = 0;
  ids.forEach(function (r, i) {
    if (wanted[String(r[0]).trim()]) {
      spots.getRange(i + 2, lvCol).setValue(today).setNumberFormat(SETTINGS.DATE_FORMAT);
      count++;
    }
  });
  return count;
}

/** Header row as trimmed strings. */
function headersOf_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}
