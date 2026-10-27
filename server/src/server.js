/* =========================================================
   Magzest server — entry point
   One Node process serves:
     /                 the website (built HTML + CMS content)
     /blog/<slug>      blog posts from the database
     /uploads/*        images and vlog videos uploaded through the admin
     /adminn/          admin dashboard (ADMIN_PATH in .env)
     /api/forms/*      public form endpoints
     /api/admin/*      admin API
   ========================================================= */

import fs from "node:fs";
import path from "node:path";
import express from "express";
import compression from "compression";
import { config } from "./config.js";
import "./db.js";
import { bootstrapAdmin, currentAdmin } from "./auth.js";
import { formsRouter } from "./routes/forms.js";
import { adminRouter } from "./routes/admin.js";
import { bookingRouter } from "./routes/booking.js";
import { opsRouter } from "./routes/ops.js";
import { trackPageView, pruneAnalytics } from "./analytics.js";
import { scheduleBackups } from "./backup.js";
import { startBiginWorker } from "./bigin.js";
import { injectCms, staticPostPath, renderPostPage, renderNotFoundPage, renderSitemap } from "./render/pages.js";
import { sitePolicy, strictPolicy, inlineScriptHashes } from "./csp.js";
import { adminPath } from "./util.js";

bootstrapAdmin();
scheduleBackups();
pruneAnalytics();
startBiginWorker();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
// gzip HTML, CSS, JS, JSON and SVG (roughly 70-80% smaller). Images and
// video are already compressed and are skipped.
app.use(compression());

// The strict policy covers the admin, the API and uploads; website pages
// replace it with the site policy in sendHtml().
const cspOptions = { upgradeInsecure: config.isProd };
const STRICT_CSP = strictPolicy(fs.readFileSync(path.join(config.serverDir, "admin", "index.html"), "utf8"), cspOptions);

app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": STRICT_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (config.isProd) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

/* ---------- API ---------- */

app.use("/api", formsRouter);
app.use("/api", bookingRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin", opsRouter);
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "Not found." }));

/* ---------- Admin dashboard (static SPA) ---------- */

// Served only at ADMIN_PATH. Any other address, "/admin" included, falls
// through to the normal "page not found" page, so the dashboard isn't advertised.
const ADMIN_PATH = adminPath();
// Non-strict routing means "/x" also matches "/x/", so check the raw URL.
app.get(ADMIN_PATH, (req, res, next) => (req.originalUrl.split("?")[0] === ADMIN_PATH ? res.redirect(301, `${ADMIN_PATH}/`) : next()));
app.use(
  ADMIN_PATH,
  express.static(path.join(config.serverDir, "admin"), {
    setHeaders: (res) => res.set({ "Cache-Control": "no-cache", "X-Robots-Tag": "noindex" }),
  })
);

/* ---------- Uploaded media ---------- */

app.use("/uploads", express.static(config.mediaDir, { maxAge: "30d", immutable: true }));

/* ---------- Website ---------- */

// Built pages are small; cache them in memory and re-read when the file changes
// (e.g. after running build.ps1), so no restart is needed.
const pageCache = new Map();
function readPage(file) {
  const { mtimeMs } = fs.statSync(file);
  const hit = pageCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.html;
  const html = fs.readFileSync(file, "utf8");
  pageCache.set(file, { mtimeMs, html });
  if (hit) siteCsp = buildSiteCsp(); // a page was rebuilt: its inline scripts may have changed
  return html;
}

// Inline scripts are allowed only if they appear in the site's own files on
// disk (built pages and templates), never because they are in content
// inserted from the database, so CMS content can't whitelist a script.
function buildSiteCsp() {
  const dirs = [config.siteRoot, path.join(config.siteRoot, "templates")];
  const hashes = new Set();
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".html"))) {
      inlineScriptHashes(fs.readFileSync(path.join(dir, f), "utf8")).forEach((h) => hashes.add(h));
    }
  }
  return sitePolicy([...hashes].sort(), cspOptions);
}
let siteCsp = buildSiteCsp();

const sendHtml = (res, html, status = 200) =>
  res.status(status).set({ "Cache-Control": "no-cache", "Content-Security-Policy": siteCsp }).type("html").send(html);

// Serve a page and count the view (admins browsing their own site aren't counted).
function sendPage(req, res, html, pagePath) {
  sendHtml(res, html);
  trackPageView(req, pagePath, { isAdmin: Boolean(currentAdmin(req)) });
}

app.get(["/", "/index"], (req, res) => sendPage(req, res, injectCms(readPage(path.join(config.siteRoot, "index.html"))), "/"));

// Top-level pages only, e.g. /careers.html (or /careers). Anything in
// pages/, templates/, server/ etc. is never reachable.
app.get(/^\/([a-z0-9-]+)(\.html)?$/, (req, res, next) => {
  const file = path.join(config.siteRoot, `${req.params[0]}.html`);
  if (!fs.existsSync(file)) return next();
  if (!req.params[1]) return res.redirect(301, `/${req.params[0]}.html`);
  sendPage(req, res, injectCms(readPage(file), { slug: req.params[0] }), `/${req.params[0]}.html`);
});

app.get("/blog/:slug", (req, res, next) => {
  const staticPage = staticPostPath(req.params.slug);
  if (staticPage) return res.redirect(301, `/${staticPage}`);
  const preview = req.query.preview !== undefined && Boolean(currentAdmin(req));
  const html = renderPostPage(req.params.slug, { preview });
  if (!html) return next();
  if (preview) return sendHtml(res, html);
  sendPage(req, res, html, `/blog/${req.params.slug}`);
});

app.get("/sitemap.xml", (req, res) => res.type("application/xml").set("Cache-Control", "max-age=3600").send(renderSitemap()));
app.get("/robots.txt", (req, res) => res.sendFile(path.join(config.siteRoot, "robots.txt")));
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(config.siteRoot, "favicon.ico"), { maxAge: config.isProd ? "1d" : 0 }));

for (const dir of ["css", "js", "assets"]) {
  app.use(`/${dir}`, express.static(path.join(config.siteRoot, dir), { maxAge: config.isProd ? "1d" : 0 }));
}

app.use((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).end();
  sendHtml(res, renderNotFoundPage(req.path), 404);
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (req.path.startsWith("/api/")) return res.status(status).json({ ok: false, error: status === 500 ? "Server error." : err.message });
  res.status(status).type("text").send(status === 500 ? "Server error." : err.message);
});

const server = app.listen(config.port, () => {
  console.log(`Magzest server running at http://localhost:${config.port}  (admin: http://localhost:${config.port}${ADMIN_PATH}/)`);
});
// Node's default 5-minute request limit is too short for a large vlog
// upload on a slow connection. Header timeouts still apply.
server.requestTimeout = 30 * 60 * 1000;
