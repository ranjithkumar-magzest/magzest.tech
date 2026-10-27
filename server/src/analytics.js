/* =========================================================
   Magzest server — cookie-free page analytics
   Counted on the server when a page is served: no cookies,
   no client script, nothing stored that identifies a person.
   Unique visitors use a hash of IP + user agent salted with
   a random value that rotates daily and is never saved, so
   yesterday's hashes can't be linked to today's.
   ========================================================= */

import crypto from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { istNow, addDays } from "./booking.js";

const BOT_RE = /bot|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|curl|wget|python|node-fetch|axios|go-http|java\/|httpclient|monitor|uptime/i;

let salt = { day: "", value: "" };
function dailySalt(day) {
  if (salt.day !== day) salt = { day, value: crypto.randomBytes(16).toString("hex") };
  return salt.value;
}

const ownHost = new URL(config.siteUrl).hostname.replace(/^www\./, "");

function source(req) {
  const utm = typeof req.query.utm_source === "string" ? req.query.utm_source.trim().toLowerCase().slice(0, 60) : "";
  if (utm) return utm;
  const ref = req.get("Referer");
  if (!ref) return null;
  try {
    const host = new URL(ref).hostname.replace(/^www\./, "");
    if (host === ownHost || host === "localhost" || host === req.hostname) return null;
    return host.slice(0, 100);
  } catch {
    return null;
  }
}

const stmts = {
  view: db.prepare("INSERT INTO page_views (day, path, views) VALUES (?, ?, 1) ON CONFLICT(day, path) DO UPDATE SET views = views + 1"),
  visitor: db.prepare("INSERT OR IGNORE INTO visitors (day, hash) VALUES (?, ?)"),
  referrer: db.prepare("INSERT INTO referrers (day, source, visits) VALUES (?, ?, 1) ON CONFLICT(day, source) DO UPDATE SET visits = visits + 1"),
};

// Call for every successfully served HTML page.
export function trackPageView(req, path, { isAdmin = false } = {}) {
  try {
    if (req.method !== "GET" || isAdmin) return;
    const ua = req.get("User-Agent") || "";
    if (!ua || BOT_RE.test(ua)) return;
    if ((req.get("Sec-Purpose") || req.get("Purpose") || "").includes("prefetch")) return;
    const day = istNow().date;
    stmts.view.run(day, path);
    const hash = crypto.createHash("sha256").update(`${dailySalt(day)}|${req.ip}|${ua}`).digest("base64url").slice(0, 16);
    const isNew = stmts.visitor.run(day, hash).changes > 0;
    const src = source(req);
    if (src || isNew) stmts.referrer.run(day, src || "Direct / unknown");
  } catch (err) {
    console.error("analytics:", err.message);
  }
}

// Visitor hashes are only needed for per-day uniqueness; drop old ones.
export function pruneAnalytics() {
  db.prepare("DELETE FROM visitors WHERE day < ?").run(addDays(istNow().date, -400));
}

export function analyticsReport(days) {
  const today = istNow().date;
  const from = addDays(today, -(days - 1));
  const prevFrom = addDays(from, -days);
  const prevTo = addDays(from, -1);

  const totals = (a, b) => ({
    views: db.prepare("SELECT COALESCE(SUM(views), 0) AS n FROM page_views WHERE day BETWEEN ? AND ?").get(a, b).n,
    visitors: db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE day BETWEEN ? AND ?").get(a, b).n,
    submissions: db
      .prepare("SELECT COUNT(*) AS n FROM submissions WHERE substr(datetime(created_at, '+330 minutes'), 1, 10) BETWEEN ? AND ?")
      .get(a, b).n,
    subscribers: db
      .prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status != 'pending' AND substr(datetime(created_at, '+330 minutes'), 1, 10) BETWEEN ? AND ?")
      .get(a, b).n,
  });

  const byDay = (sql) => Object.fromEntries(db.prepare(sql).all(from, today).map((r) => [r.day, r.n]));
  const views = byDay("SELECT day, SUM(views) AS n FROM page_views WHERE day BETWEEN ? AND ? GROUP BY day");
  const visitors = byDay("SELECT day, COUNT(*) AS n FROM visitors WHERE day BETWEEN ? AND ? GROUP BY day");
  const subs = byDay(
    "SELECT substr(datetime(created_at, '+330 minutes'), 1, 10) AS day, COUNT(*) AS n FROM submissions WHERE day BETWEEN ? AND ? GROUP BY day"
  );
  const daily = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    daily.push({ day, views: views[day] || 0, visitors: visitors[day] || 0, submissions: subs[day] || 0 });
  }

  return {
    from,
    to: today,
    current: totals(from, today),
    previous: totals(prevFrom, prevTo),
    daily,
    pages: db.prepare("SELECT path, SUM(views) AS views FROM page_views WHERE day BETWEEN ? AND ? GROUP BY path ORDER BY views DESC LIMIT 15").all(from, today),
    sources: db.prepare("SELECT source, SUM(visits) AS visits FROM referrers WHERE day BETWEEN ? AND ? GROUP BY source ORDER BY visits DESC LIMIT 10").all(from, today),
    conversions: db
      .prepare(
        "SELECT type, COUNT(*) AS n FROM submissions WHERE substr(datetime(created_at, '+330 minutes'), 1, 10) BETWEEN ? AND ? GROUP BY type"
      )
      .all(from, today),
  };
}
