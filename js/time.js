/*
 * time.js — time helpers. All times are stored as "minutes after midnight" (e.g. 4:30 PM = 990).
 * Days are indexed 0–6 starting Monday, matching the Mon…Sun columns in the Schedules tab.
 */
window.HH = window.HH || {};

HH.DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
HH.DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
HH.END_OF_DAY = 24 * 60; // used for "until close"

/** Current day index (0 = Mon) and minutes after midnight in the given time zone. */
HH.nowIn = function nowIn(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const day = HH.DAYS.indexOf(get("weekday"));
  return { day: day === -1 ? 0 : day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
};

/**
 * Parse a time as Google Sheets may export it: "2:00 PM", "2 PM", "2:00:00 PM", "14:00",
 * "14:00:00", or a spreadsheet day-fraction like "0.5833". Returns minutes or null.
 */
HH.parseTime = function parseTime(value) {
  const s = String(value == null ? "" : value).trim().toUpperCase();
  if (!s) return null;
  if (/^0?\.\d+$/.test(s)) return Math.round(parseFloat(s) * 24 * 60); // day fraction
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM|A|P)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ampm = m[3];
  if (ampm) {
    if (h === 12) h = 0;
    if (ampm.startsWith("P")) h += 12;
  }
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
};

/** 990 → "4:30 PM"; 960 → "4 PM". */
HH.formatTime = function formatTime(minutes, { suffix = true } = {}) {
  const m = ((minutes % HH.END_OF_DAY) + HH.END_OF_DAY) % HH.END_OF_DAY;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "AM" : "PM";
  return `${h12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${suffix ? " " + ampm : ""}`;
};

/** Human-friendly duration: 45 → "45 min", 90 → "1 hr 30 min". */
HH.formatDuration = function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
};

/** Parse "2026-10-20", "10/20/2026", or anything Date understands. Returns a Date or null. */
HH.parseDate = function parseDate(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) return new Date(Number(us[3].length === 2 ? "20" + us[3] : us[3]), Number(us[1]) - 1, Number(us[2]));
  const d = new Date(s);
  return isNaN(d) ? null : d;
};
