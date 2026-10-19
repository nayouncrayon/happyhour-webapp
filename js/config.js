/*
 * config.js — the ONLY file you need to edit to connect the app to your Google Sheet.
 *
 * Two ways to connect (pick one):
 *
 *   Option A — Sheet ID (easiest)
 *     1. Open the sheet in Google Sheets (if it's still an .xlsx in Drive: File → Save as Google Sheets).
 *     2. Share → General access → "Anyone with the link" → Viewer.
 *     3. Copy the ID from the URL:  https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit
 *     4. Paste it into GOOGLE_SHEET_ID below.
 *
 *   Option B — "Publish to web" CSV links (use this if Option A shows missing data)
 *     File → Share → Publish to web → pick a tab (Spots) → Comma-separated values (.csv) → Publish.
 *     Copy the link into CSV_URLS.spots. Repeat for Schedules and Deals.
 *     When all three CSV_URLS are filled in, they are used instead of GOOGLE_SHEET_ID.
 *
 * If neither is set (or the sheet can't be reached), the app shows the built-in sample data
 * from data/sample-data.js and displays a banner saying so.
 */
window.HH_CONFIG = {
  // "Downtown SD Happy Hours" sheet:
  // https://docs.google.com/spreadsheets/d/1a4U4op6vxPKuRsfaVSqF75ghKzmkLLjn6ISZzOw5Q-w/edit
  GOOGLE_SHEET_ID: "1a4U4op6vxPKuRsfaVSqF75ghKzmkLLjn6ISZzOw5Q-w",

  CSV_URLS: {
    spots: "",
    schedules: "",
    deals: "",
  },

  // Tab names in the Google Sheet. Must match exactly (used with GOOGLE_SHEET_ID).
  TAB_NAMES: {
    spots: "Spots",
    schedules: "Schedules",
    deals: "Deals",
  },

  // Fall back to data/sample-data.js when the sheet can't be loaded.
  USE_SAMPLE_DATA_IF_SHEET_FAILS: true,

  // All "happening now" math uses San Diego time, even if the viewer's phone is set elsewhere.
  TIME_ZONE: "America/Los_Angeles",

  // Some windows say "From opening" or "All day" instead of a start time.
  // We don't store opening hours, so this time is assumed as the start for those.
  ASSUMED_OPENING_TIME: "11:00",

  // A happy hour starting within this many minutes is labelled "Starts soon".
  STARTING_SOON_MINUTES: 60,

  APP_TITLE: "Happy Hour SD",
  APP_SUBTITLE: "Downtown San Diego",

  // Map starting point (Little Italy / downtown) and zoom level.
  MAP_CENTER: [32.7195, -117.1665],
  MAP_ZOOM: 15,

  // Map background tiles: OpenStreetMap's standard tiles (free, no API key; attribution required).
  // In dark mode the app dims and inverts them with CSS (.map.is-dark in css/styles.css).
  MAP_TILES: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};
