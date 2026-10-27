/*
 * Serves the static site for Node hosts (Hostinger Node.js apps run
 * `npm start`). No dependencies. Only the public files are served:
 * the top-level pages, css/, js/, assets/, favicon.ico, robots.txt and
 * sitemap.xml. The security headers come from .htaccess, so Node and
 * Apache hosting send the same ones.
 *
 *   node serve.mjs            http://localhost:3000 (or $PORT)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const headers = {};
for (const [, name, value] of fs.readFileSync(path.join(ROOT, ".htaccess"), "utf8").matchAll(/Header always set (\S+) "([^"]*)"/g)) {
  headers[name] = value;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

const isPublic = (rel) =>
  /^[\w-]+\.html$/.test(rel) || /^(css|js|assets)\//.test(rel) || ["favicon.ico", "robots.txt", "sitemap.xml"].includes(rel);

function send(res, status, file) {
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  // Pages are revalidated on every visit; css/js/images are cached for a day.
  const cache = type.startsWith("text/html") ? "no-cache" : "public, max-age=86400";
  res.writeHead(status, { ...headers, "Content-Type": type, "Cache-Control": cache });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...headers, Allow: "GET, HEAD" });
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/+/, "");
    } catch {
      rel = "";
    }
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = path.join(ROOT, rel);
    const found = !rel.includes("..") && isPublic(rel) && fs.existsSync(file) && fs.statSync(file).isFile();
    if (found) return send(res, 200, file);
    res.writeHead(404, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><meta charset="utf-8"><title>Page not found</title><p>Page not found. <a href="/">Go to the homepage</a></p>');
  })
  .listen(PORT, () => console.log(`Magzest site running at http://localhost:${PORT}`));
