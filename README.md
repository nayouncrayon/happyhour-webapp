# Happy Hour SD

A mobile-friendly web app that shows happy hours in downtown San Diego: what's on now, what starts soon, the deals, and a map. The data lives in a Google Sheet, so updating a deal means editing a cell. You never touch the code to do it.

- **Plain HTML, CSS and JavaScript.** No frameworks, no build step, no npm. Open `index.html` and it runs.
- **Free to run.** Google Sheets holds the data, OpenStreetMap draws the map (no API key), and any static host can serve the site.
- **Owned by you.** Nothing here is tied to a vendor, an AI tool, or an employer account.

---

## Quick start

1. **Try it now:** double-click `index.html`. Until a sheet is connected, it shows the built-in sample data and a banner saying so.
2. **Connect your Google Sheet** (one-time setup):
   1. Open the file in Google Sheets. If it's still an `.xlsx` in Drive, use **File → Save as Google Sheets** first.
   2. Click **Share → General access → Anyone with the link → Viewer**.
   3. Copy the sheet ID from the URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
   4. Paste it into `GOOGLE_SHEET_ID` in `js/config.js` and save.
   5. Reload the page. The banner disappears once the app is reading your sheet.
3. **Put it online** (pick one; both are free):
   - **Netlify Drop:** go to app.netlify.com/drop and drag the whole `happy-hour-app` folder onto the page. You get a link right away.
   - **GitHub Pages:** create a repository, upload these files, then go to **Settings → Pages → Deploy from branch → main → / (root)**. Keep `index.html` at the top level of the repo. This also gives you version history.

> **Ownership tip:** use a *personal* Google account for the sheet, and a personal Netlify or GitHub account for hosting. Work accounts often block public sharing, and you lose access to them when you leave the job.

If some cells show up blank after connecting (rare; it happens with columns that mix numbers and text), switch to Option B in `js/config.js`. Use **File → Share → Publish to web**, choose each tab as CSV, and paste the three links.

---

## Updating the data (no code)

Everything is edited in the Google Sheet. Changes show up the next time someone opens or refreshes the app.

| Tab | One row per… | Key columns |
|---|---|---|
| **Spots** | restaurant or bar | `Spot ID` (S01…), name, neighborhood, address, links, price, `HH seating`, `Status`, `Last verified`, `Latitude`/`Longitude` |
| **Schedules** | happy hour window or day special | `Schedule ID` (H001…), `Spot ID`, `Kind`, TRUE/FALSE for `Mon`…`Sun`, `Start`, `End`, `Time note` |
| **Deals** | single deal | `Deal ID` (D001…), `Spot ID`, optional `Schedule ID`, `Category` (Drink/Food/Combo), `Item`, `Price ($)`, `Discount` |

Rules the app follows:

- **Linking:** Schedules and Deals point to a spot through `Spot ID`.
- **Which deals show where:** a deal with a blank `Schedule ID` appears on all of that spot's *Happy hour* and *Late night* windows. A deal with a `Schedule ID` appears only on that window, which is how day specials like Taco Tuesday get their own deals.
- **Kind** decides labels and filtering: `Happy hour`, `Late night`, `Day special` or `Event`.
- **Times:**
  - Blank `Start`/`End` fall back to `Time note`.
  - "From opening" uses `ASSUMED_OPENING_TIME` from the config as the start.
  - "Until close" runs to the end of the day.
  - "All day" is both of the above.
  - Anything else shows as "Hours not listed".
- **No days ticked** (e.g. "days unknown", Padres win): the window appears in a "Days not listed" section on every day.
- **`Days confirmed?` = FALSE** shows a "Days unconfirmed" badge.
- **`Last verified`:** filled in automatically once you install the script below, or type a date yourself. The footer shows the % of spots verified in the last 30 days.
- **Map pins:** each pin needs `Latitude` and `Longitude`. For a new spot, right-click the place in Google Maps and click the coordinates to copy them.
- **Columns:** add, reorder or ignore columns freely. Renaming one requires the matching edit in `HH.COLUMNS` in `js/data.js`.

### Auto-fill "Last verified" (optional, one-time setup)

`google-apps-script/auto-last-verified.gs` is a small Google Apps Script that lives inside the sheet.

- **Automatic stamp:** editing a spot's row on Spots, or any of its rows on Schedules or Deals, sets that spot's `Last verified` to today. Edits to helper columns like `Spot (auto)` or `# Deals` don't count.
- **Menu item:** **Happy Hour → Mark selected spots verified today** stamps the date when you checked a spot and nothing changed.

To install:

1. In the sheet, go to **Extensions → Apps Script**, paste the whole file, and click **Save**.
2. Reload the sheet. The first time you use the menu, Google asks you to authorize the script; it only touches this spreadsheet.
3. Check that **File → Settings → Time zone** is Pacific, so "today" means San Diego's today.

Note that any edit counts, including fixing a typo. If you only want to stamp spots you actually checked, skip the automatic part and use just the menu: delete the `onEdit` function from the script.

---

## Project structure

```
happy-hour-app/
├── index.html          Page skeleton. Loads the files below in order.
├── css/styles.css      All styling. Colors are tokens at the top (light + dark mode).
├── js/config.js        Settings: Google Sheet ID, tab names, time zone, map center. The only file you must edit.
├── js/csv.js           Tiny CSV parser (no libraries).
├── js/time.js          Time helpers: San Diego "now", parse "4:30 PM", format "4–6 PM".
├── js/data.js          Loads the 3 tabs, cleans rows, links them, computes status (on now / soon / later / ended).
├── js/app.js           UI: week strip, search, list cards, filters sheet, tab bar, map. Reads the model from data.js.
├── data/sample-data.js Snapshot of the sheet as CSV text; used when no sheet is connected.
├── google-apps-script/auto-last-verified.gs  Optional script pasted into the sheet (Extensions → Apps Script) to auto-stamp Last verified.
└── README.md           This file.
```

**Design:** iOS-style (Apple Human Interface Guidelines): system font, grouped backgrounds, frosted bars, a bottom tab bar, and iOS teal as the accent. All colors are tokens at the top of `css/styles.css`, with light and dark mode following the phone's setting.

**External dependency:** Leaflet 1.9.4 (map library) loads from unpkg.com, and map tiles come from OpenStreetMap (free, no API key; set in `MAP_TILES` in `js/config.js`). Dark mode inverts the tiles with a CSS filter. If they fail to load, the list still works and the map view says it couldn't load.

---

## Notes for AI assistants (ChatGPT, Claude, Copilot, etc.)

Read this before modifying the project.

- **Architecture:** a static site with vanilla JS and no build step. Scripts are classic `<script defer>` tags (not ES modules) so the page works when opened straight from disk (`file://`). Everything hangs off one global namespace, `window.HH`; config lives in `window.HH_CONFIG`.
- **Data flow:** `HH.loadData(config)` → loads the 3 tabs. With `GOOGLE_SHEET_ID` it uses the Google Sheets gviz endpoint as JSONP (`HH.loadTabJsonp`, a `<script>` tag, so no CORS issues and it works from `file://`), falling back to `fetch()` of gviz CSV. With `CSV_URLS` it uses `fetch()` + `HH.parseCSV`. Both yield row objects keyed by header → `HH.buildModel(raw, config)` → `{ spots: Map<id, spot>, schedules: [], deals: [] }`. Each schedule holds a reference to its `spot` and an array of attached `deals`. `HH.statusFor(schedule, dayIndex, now, config)` returns `{ state, label, sortKey }`.
- **Conventions:**
  - Day index 0 = Monday … 6 = Sunday.
  - Times are minutes after midnight; `HH.END_OF_DAY` (1440) means "until close".
  - "Now" is always computed in `config.TIME_ZONE` (America/Los_Angeles).
- **Separation:** `data.js` must stay DOM-free. All rendering lives in `app.js`, which builds HTML strings. All sheet text passes through `esc()`, and links pass through `safeUrl()` or `telUrl()`. Keep it that way, because the sheet is user-editable content.
- **Column names:** sheet headers are mapped in one place, `HH.COLUMNS` in `data.js`. Don't hard-code header strings elsewhere.
- **Fallback:** if no sheet is configured or loading fails, the app uses `window.HH_SAMPLE_CSV` from `data/sample-data.js` and shows a banner.
- **Preferences:** view and filters are saved in `localStorage` under `hh-preferences-v1`, wrapped in try/catch. This is a per-device convenience, never a data store.
- **Testing:** there's no test runner. The logic in `csv.js`, `time.js` and `data.js` can be exercised in Node by loading those files into a `vm` context with a fake `window`.
- **Out of scope for v1:** logins/accounts, photo upload, ratings/reviews, notifications, user incentive programs, dietary filters, crawl planning, social features, and filtering by happy hour type. These were deliberately left out; see the PRD.

---

## Ideas for later

- A "Suggest a correction" link (e.g. a Google Form that writes to a new tab).
- A crowd-level or "busy?" signal.
- Expanding beyond downtown: add spots with their own neighborhoods, then update the map center and title in `config.js`.
