/*
 * csv.js — a small, dependency-free CSV parser.
 *
 * HH.parseCSV(text) → array of row objects keyed by the header row.
 * Handles quoted fields, commas and line breaks inside quotes, "" escapes,
 * Windows line endings, and a leading byte-order mark.
 */
window.HH = window.HH || {};

HH.parseCSV = function parseCSV(text) {
  text = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (!nonEmpty.length) return [];

  const headers = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = (cells[idx] || "").trim(); });
    return obj;
  });
};
