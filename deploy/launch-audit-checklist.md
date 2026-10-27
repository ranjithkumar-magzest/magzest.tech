# Launch technical audit checklist — www.magzest.tech

Run this after every deploy that changes the server, Nginx config or page templates.
Status column reflects a review of the code in this repo (October 2026); items marked
**Verify** can only be confirmed against the live server.

Legend: ✅ in place · ⚠️ partly / worth improving · ❌ missing · 🔎 verify on live site

Quick live checks used below:

```sh
curl -sI https://www.magzest.tech/                 # response headers
curl -sI http://magzest.tech/                      # should 301 to https://www.
curl -sI -H "Accept-Encoding: gzip" https://www.magzest.tech/css/tailwind.css
curl -sI -H "Origin: https://evil.example" https://www.magzest.tech/api/health
```

---

## 1. Web security

### HTTPS / TLS

| # | Check | Status | Notes |
|---|---|---|---|
| 1.1 | Valid TLS certificate for apex and `www` | ✅ 🔎 | Certbot issues for both in `deploy/setup-vps.sh`. Confirm auto-renew: `sudo certbot renew --dry-run`. |
| 1.2 | HTTP → HTTPS redirect | ✅ | Certbot `--redirect`. |
| 1.3 | HSTS header | ✅ | `max-age=31536000; includeSubDomains` in production (`server/src/server.js`). Add `preload` and submit to hstspreload.org only once every subdomain is HTTPS-only. |
| 1.4 | Apex ↔ `www` canonical host redirect | ❌ | Nginx proxies both `magzest.tech` and `www.magzest.tech` to the app, and the app serves both. Canonical tags limit SEO damage, but add a 301 from apex to `www` in Nginx. |
| 1.5 | TLS 1.2+ only, modern ciphers | 🔎 | Certbot's `options-ssl-nginx.conf` is sane by default. Check with SSL Labs (target A or A+). |
| 1.6 | No mixed content | 🔎 | All external assets are https. Check DevTools console on every page. |

### Cookies

| # | Check | Status | Notes |
|---|---|---|---|
| 1.7 | Session cookie `mz_admin` is `HttpOnly` | ✅ | `server/src/auth.js` |
| 1.8 | Session cookie is `Secure` | ✅ | Only when `NODE_ENV=production` (`config.isProd`). 🔎 Confirm the service sets production mode, or the cookie goes out without `Secure`. |
| 1.9 | Session cookie is `SameSite=Strict` | ✅ | Plus custom-header check for CSRF. |
| 1.10 | Session cookie signed, short-lived | ✅ | HMAC-signed, 12 h default (`SESSION_HOURS`). Confirm `SESSION_SECRET` is a long random value in `.env`. |
| 1.11 | Consent cookie flags | ✅ | `magzest-cookie-consent` is set from JS with `SameSite=Lax`, plus `Secure` whenever the page is on HTTPS. |
| 1.12 | Cookie Policy lists every cookie / storage key | ✅ | `cookie-policy.html`. Update it whenever a cookie or storage key is added. |

### CORS

| # | Check | Status | Notes |
|---|---|---|---|
| 1.13 | No permissive `Access-Control-Allow-Origin` | ✅ 🔎 | No CORS middleware is installed, so the API is same-origin only. Confirm that the curl `Origin` check above returns no `Access-Control-Allow-*` headers. |
| 1.14 | If CORS is ever added, use an explicit origin allow-list (never `*` with credentials) | — | Not applicable today. |

### Security headers

| # | Check | Status | Notes |
|---|---|---|---|
| 1.15 | `X-Content-Type-Options: nosniff` | ✅ | |
| 1.16 | `X-Frame-Options: SAMEORIGIN` | ✅ | |
| 1.17 | `Referrer-Policy: strict-origin-when-cross-origin` | ✅ | |
| 1.18 | `Permissions-Policy` | ✅ | camera / microphone / geolocation disabled. |
| 1.19 | `Content-Security-Policy` | ❌ | Biggest remaining gap. Start with `Content-Security-Policy-Report-Only` allowing `'self'`, `unpkg.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, `www.google.com` (Maps frame), `www.youtube-nocookie.com` / `player.vimeo.com` (frames), `i.ytimg.com` (images); add `frame-ancestors 'self'`. Watch for inline scripts/styles before enforcing. |
| 1.20 | `X-Powered-By` removed | ✅ | `app.disable("x-powered-by")` |
| 1.21 | Nginx version hidden | ❌ | Add `server_tokens off;` to the Nginx config. |
| 1.22 | Subresource Integrity on CDN scripts | ✅ | AOS and Lucide from unpkg are pinned and use `integrity`. |

### Application

| # | Check | Status | Notes |
|---|---|---|---|
| 1.23 | Rate limiting on login and forms | ✅ | `express-rate-limit` on admin login, sign-in codes and form routes. |
| 1.24 | Upload size limits | ✅ | Nginx 6 MB global, 510 MB only on `/api/admin/videos`. |
| 1.25 | Internal folders not web-reachable | ✅ | Only top-level `*.html`, `css/`, `js/`, `assets/`, `uploads/` are served. 🔎 Spot-check `/server/`, `/pages/`, `/.env`, `/.git/` all return 404. |
| 1.26 | Admin area not indexed | ✅ | `X-Robots-Tag: noindex` on the admin (`/adminn`). |
| 1.27 | Dependencies audited | 🔎 | `cd server && npm audit --omit=dev` |
| 1.28 | Backups running and restorable | ✅ 🔎 | `scheduleBackups()` exists. Do one test restore. |

---

## 2. Performance

| # | Check | Status | Notes |
|---|---|---|---|
| 2.1 | Text compression (gzip/brotli) for CSS/JS/JSON/SVG | ❌ 🔎 | Express has no compression middleware, and Debian's default Nginx only gzips `text/html`. Add `gzip_types text/css application/javascript application/json image/svg+xml application/xml;` (and `gzip_proxied any;`). |
| 2.2 | HTML caching | ✅ | `Cache-Control: no-cache` (revalidates, so content edits show immediately). |
| 2.3 | Static asset caching | ⚠️ | `css/`, `js/`, `assets/` use `max-age=1d`. Filenames aren't fingerprinted, so longer caching would serve stale files after deploys. Option: add a `?v=<build hash>` query in templates, then raise to 1 year + `immutable`. |
| 2.4 | Uploaded media caching | ✅ | `/uploads` 30 d, `immutable`. |
| 2.5 | Scripts non-blocking | ✅ | All footer scripts use `defer`. |
| 2.6 | Web fonts | ⚠️ | `display=swap` ✅. Add `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` (only `fonts.googleapis.com` is preconnected), or self-host Inter/Poppins. |
| 2.7 | Tailwind CSS built and purged | ✅ | `build-css.ps1` outputs a compiled `css/tailwind.css` (no CDN runtime). |
| 2.8 | JS minified | ✅ | esbuild `*.min.js`. |
| 2.9 | Images sized, compressed and lazy-loaded | 🔎 | Below-the-fold `<img>` should have `loading="lazy"` and explicit `width`/`height` (prevents layout shift). Convert large PNG/JPG to WebP/AVIF. |
| 2.10 | Heavy embeds deferred | ✅ | Vlog players and the Contact page Google Map are click-to-load (no third-party requests or cookies until clicked). |
| 2.11 | Core Web Vitals | 🔎 | PageSpeed Insights on Home, Services, Contact, Blog (mobile). Targets: LCP < 2.5 s, INP < 200 ms, CLS < 0.1. |
| 2.12 | HTTP/2 enabled | 🔎 | Certbot's Nginx block may leave `listen 443 ssl;` without `http2`. Add it. |

---

## 3. Core SEO

| # | Check | Status | Notes |
|---|---|---|---|
| 3.1 | Unique `<title>` and meta description per page | ✅ | Front-matter in `pages/*.html`. Keep titles ≤ 60 chars and descriptions ≤ 160. |
| 3.2 | Canonical URL on every page | ✅ | `https://www.magzest.tech/...`; homepage canonicalised to bare domain. |
| 3.3 | Open Graph tags | ✅ | `og:title/description/type/url/site_name/image` (1200×630) on main template. Test with LinkedIn Post Inspector before announcing. |
| 3.4 | Twitter/X card tags | ✅ | `summary_large_image`. |
| 3.5 | Structured data (JSON-LD) | ✅ 🔎 | Present on the homepage. Validate with Google Rich Results Test; consider `Article` schema on blog posts. |
| 3.6 | `robots.txt` | ✅ | Allows all, declares sitemap. |
| 3.7 | `sitemap.xml` | ✅ | Static pages + published CMS posts generated live. Submit in Google Search Console and Bing Webmaster Tools. |
| 3.8 | Legal pages excluded from index | ✅ | Legal template sets `noindex, follow` (Privacy, Terms, Cookie Policy). |
| 3.9 | Clean URLs / no duplicates | ⚠️ | `/page` → `/page.html` 301 ✅; apex vs `www` not redirected (see 1.4). |
| 3.10 | Custom 404 returns real 404 status | ✅ | `renderNotFoundPage` with status 404. |
| 3.11 | One `<h1>` per page, logical heading order | 🔎 | Spot-check with an SEO browser extension. |
| 3.12 | Image `alt` text | 🔎 | Every meaningful image needs descriptive alt; decorative ones `alt=""`. |
| 3.13 | Search Console set up, domain verified | 🔎 | Also check Coverage report a week after launch. |

---

## Priority fixes

1. Add a Content-Security-Policy (start in Report-Only). (1.19)
2. Enable gzip for CSS/JS/JSON/SVG in Nginx. (2.1)
3. 301 apex → `www`. (1.4 / 3.9)
4. `server_tokens off;` and `http2` on the 443 listener. (1.21 / 2.12)
5. Preconnect `fonts.gstatic.com`. (2.6)
