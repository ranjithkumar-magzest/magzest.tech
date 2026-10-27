/* =========================================================
   Magzest server — small shared helpers
   ========================================================= */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Trimmed string field, capped so nobody can stuff megabytes into the DB.
export function str(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = String(v ?? "");
    // Leading =,+,-,@ would be evaluated as formulas by Excel.
    const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
    return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  const lines = [columns.map((c) => cell(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(c.get(row))).join(","));
  return "﻿" + lines.join("\r\n");
}

// Where a vlog's video comes from: a file uploaded through the admin, or
// a YouTube / Vimeo link (turned into a privacy-friendly embed URL).
// Anything else returns null, so arbitrary URLs never end up in a page.
export function videoSource(value) {
  const v = String(value || "").trim();
  if (/^uploads\/videos\/[a-z0-9-]+\.(mp4|webm|mov|m4v)$/.test(v)) return { type: "file", src: v };
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^(www|m)\./, "");
  const ytId = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null);
  let id = null;
  if (host === "youtu.be") id = ytId(url.pathname.slice(1));
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = ytId(url.searchParams.get("v")) || ytId(url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1]);
  }
  if (id) return { type: "youtube", id, src: `https://www.youtube-nocookie.com/embed/${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const vimeo = url.pathname.match(/(?:^|\/)(\d{5,12})(?:\/|$)/)?.[1];
    if (vimeo) return { type: "vimeo", id: vimeo, src: `https://player.vimeo.com/video/${vimeo}?dnt=1` };
  }
  return null;
}

export function nowIso() {
  return new Date().toISOString();
}

// Where the admin dashboard is served, default "/adminn". Set ADMIN_PATH in
// server/.env to move it; "/admin" is deliberately not used.
// Read lazily so server/.env has been loaded first.
export function adminPath() {
  const p = String(process.env.ADMIN_PATH || "adminn").replace(/^\/+|\/+$/g, "");
  return "/" + (p || "adminn");
}
