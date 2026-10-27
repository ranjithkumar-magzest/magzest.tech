/* =========================================================
   Magzest server — Content-Security-Policy
   Tells browsers which sources a page may load scripts,
   styles, frames etc. from, so injected markup can't run
   code. Inline <script> blocks are allowed by their SHA-256
   hash, worked out from the pages themselves, so editing a
   page never needs a change here.

   Used by the Node server (per response) and by
   deploy/make-htaccess.mjs, which writes the same site policy
   into .htaccess for static hosting.
   ========================================================= */

import crypto from "node:crypto";

// Zoho SalesIQ (chat widget) loads its code, styles, media and a
// websocket from these Zoho domains.
const ZOHO = ["https://*.zohopublic.in", "https://*.zoho.in", "https://*.zohocdn.com"];
const VIDEO_FRAMES = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"];
const FONTS_CSS = "https://fonts.googleapis.com";
const FONTS = "https://fonts.gstatic.com";

// Hashes of the inline scripts in a page. JSON-LD blocks are data, not
// code, so they don't need one. Browsers hash the script after turning
// CRLF line endings into LF, so the same is done here.
export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(attrs) || /application\/ld\+json/i.test(attrs)) continue;
    const digest = crypto.createHash("sha256").update(body.replace(/\r\n?/g, "\n"), "utf8").digest("base64");
    hashes.add(`'sha256-${digest}'`);
  }
  return [...hashes];
}

const build = (directives) =>
  Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");

// upgradeInsecure is for HTTPS sites only: on http://localhost it would
// break loading the site's own files.
const common = (upgradeInsecure) => ({
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "form-action": ["'self'"],
  ...(upgradeInsecure && { "upgrade-insecure-requests": [] }),
});

// Public website pages (built HTML, blog posts, 404). `hashes` are the
// inline scripts to allow; see inlineScriptHashes().
export function sitePolicy(hashes, { upgradeInsecure = false } = {}) {
  return build({
    "default-src": ["'self'"],
    "script-src": ["'self'", ...hashes, "https://unpkg.com", ...ZOHO],
    // Inline style attributes are used throughout the pages and by the chat widget.
    "style-src": ["'self'", "'unsafe-inline'", FONTS_CSS, "https://unpkg.com", ...ZOHO],
    "font-src": ["'self'", "data:", FONTS, ...ZOHO],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:", ...ZOHO],
    // On static hosting there is no /api, so forms post to Bigin and
    // formsubmit.co directly (see MagzestForm in js/main.js).
    "connect-src": ["'self'", ...ZOHO, "wss://*.zohopublic.in", "wss://*.zoho.in", "https://formsubmit.co", "https://bigin.zoho.in"],
    "frame-src": [...VIDEO_FRAMES, ...ZOHO],
    "frame-ancestors": ["'self'"],
    ...common(upgradeInsecure),
  });
}

// Everything else: the admin dashboard, API responses and uploaded files.
// Only same-origin code, so an uploaded file can never run a script.
export function strictPolicy(adminHtml, { upgradeInsecure = false } = {}) {
  return build({
    "default-src": ["'self'"],
    "script-src": ["'self'", ...inlineScriptHashes(adminHtml)],
    "style-src": ["'self'", "'unsafe-inline'", FONTS_CSS],
    "font-src": ["'self'", FONTS],
    // Vlog thumbnails come from YouTube; previews embed the player.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:"],
    "connect-src": ["'self'"],
    "frame-src": VIDEO_FRAMES,
    "frame-ancestors": ["'none'"],
    ...common(upgradeInsecure),
  });
}
