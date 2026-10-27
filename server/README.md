# Magzest server

Node.js backend for magzest.tech. One process serves the website, the form API, the admin dashboard and the CMS content.

| URL | What |
| --- | --- |
| `/`, `/careers.html`, … | The built site. Jobs, blog cards and portfolio projects come from the database |
| `/blog/<slug>` | Blog post pages (Markdown → HTML) |
| `/adminn/` | Admin dashboard (address set by `ADMIN_PATH`; `/admin` shows "page not found") |
| `/api/forms/{contact,application,booking,newsletter}` | Form endpoints used by the site's JS |
| `/sitemap.xml` | Static sitemap + published blog posts |

Stack: Express 5, SQLite through Node's built-in `node:sqlite` (no native modules), Nodemailer (SMTP), Multer (uploads).

## Run locally

Requires Node.js 22.13 or newer.

```powershell
cd server
npm install
copy .env.example .env      # then edit: set NODE_ENV=development, ADMIN_EMAIL, ADMIN_PASSWORD
npm run dev                 # http://localhost:3000  and  http://localhost:3000/adminn/
```

On first start the server creates `server/data/` (database and uploads). It also imports the jobs, blog cards and portfolio projects that are currently in `pages/*.html`, and creates the admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Forgot the password? Run `npm run create-admin -- you@magzest.tech "new long password"`.

Run the tests with `npm test`. They start the real server against a throwaway data folder with email and Bigin sync turned off, so nothing real is touched. They take about 20 seconds.

## How CMS content reaches the pages

`pages/careers.html`, `pages/blog.html` and `pages/portfolio.html` wrap their dynamic sections in marker comments:

```html
<div class="grid ..."><!-- cms:jobs --> …static cards… <!-- /cms:jobs --></div>
```

When a page is served, `src/render/pages.js` replaces the region with database content. The static content stays in place as a fallback, so the HTML files still work if they're opened without the server.

- After editing `pages/` or `templates/`, run `build.ps1` as before. The server notices the changed files automatically, with no restart.
- `src/render/` is in Tailwind's `@source` list. If you add new Tailwind classes there, rebuild the CSS with `build-css.ps1`.

## Email

Set the `SMTP_*` values in `.env`, using the mailbox for contact@magzest.tech (Zoho, Google Workspace with an app password, Hostinger mail, etc.). Admin → Settings shows whether the connection works.

Each submission emails `NOTIFY_EMAIL`, and applications come with the resume attached. The person who submitted gets an auto-reply (turn this off with `AUTO_REPLY=false`). If SMTP isn't configured or fails, the submission is still saved in the admin.


## Pipelines, calendar, analytics, backups

Everything below lives in the admin dashboard. The server code is in `src/routes/ops.js`, `src/booking.js`, `src/analytics.js` and `src/backup.js`; the UI is in `admin/ops.js`.

- **Leads (CRM):** contact messages and call bookings appear on a board with the stages New → Contacted → Proposal → Won / Lost. Each lead can have a deal value (₹) and a follow-up date, and the dashboard shows open pipeline value and follow-ups that are due.
- **Hiring pipeline:** applications move through New → Shortlisted → Interview → Offer → Hired / Rejected, with a 1–5 star rating. When a candidate is moved to a stage, the admin offers a ready-made email for that stage, which you can edit before sending. Every stage change, note and email is recorded on the card's activity timeline.
- **Call calendar:** the website's booking modal only offers free slots, and the same slot can't be booked twice. Slots are in IST (Asia/Kolkata). Working hours, call length, minimum notice, how far ahead people can book, blocked dates and a default meeting link are set under Call calendar → Availability settings. When you **confirm**, **reschedule** or **cancel** a call, the client gets an email with a calendar invite (`.ics`) that works in Outlook and Google Calendar. If the booking modal can't reach the server (for example on static hosting), it falls back to the plain date and time inputs.
- **Analytics:** page views are counted on the server, with no cookies and no tracking script. Unique visitors are counted with a hash salted with a random value that changes daily and is never stored. Bots and logged-in admins aren't counted. Traffic sources come from the referrer or a `?utm_source=` tag.
- **Encryption at rest:** personal data (form submissions, subscriber emails, CRM notes and activity, visitor IPs, resumes) is stored AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY`. Existing plaintext data is encrypted automatically on the next start. **Keep a copy of the key somewhere safe**: without it the data and every backup are unreadable, and it can't be changed once data is encrypted. In development a key is generated in `data/.data-key`.
- **Backups:** a snapshot of the database goes to `DATA_DIR/backups` once a day, and the newest 14 are kept. You can download them or create one on demand under Settings. Uploaded files (resumes, images) are **not** included, so back up `DATA_DIR/uploads` separately.

Emails sent from the pipelines and calendar need SMTP (see Email). Without it, every action still works, and the admin shows that the email wasn't sent.

## Deploying

Any host that runs a long-lived Node process and has a **persistent disk** will work. The database and uploaded files live in `DATA_DIR`.

**VPS (Hostinger VPS, DigitalOcean, Lightsail…)**

```bash
git clone … && cd magzest-website/server
npm ci --omit=dev
cp .env.example .env && nano .env        # NODE_ENV=production, SESSION_SECRET, DATA_ENCRYPTION_KEY, SMTP, admin
npm i -g pm2 && pm2 start src/server.js --name magzest && pm2 save && pm2 startup
```

Put Nginx (or Caddy) in front for HTTPS, proxy to port 3000, and keep `TRUST_PROXY=1`. Set `client_max_body_size 6m;` in Nginx so resume uploads aren't blocked.

**Render / Railway:** root directory `server`, build `npm ci --omit=dev`, start `npm start`. Add a persistent disk/volume and point `DATA_DIR` at it (for example `/var/data`). Without one, all submissions are lost on every deploy.

**Backups:** copy `DATA_DIR` (it holds `magzest.db` and `uploads/`). For a consistent copy while the server is running, use `sqlite3 magzest.db ".backup backup.db"`.

## Security notes

- Admin sign-in has two steps: the password, then a 6-digit code emailed to the admin's address. A code expires after 10 minutes, works once and allows 5 tries. Production needs SMTP for this. In development without SMTP, the code is printed in the server console. `ADMIN_MFA=false` turns the email step off.
- Admin sessions use an HMAC-signed, HttpOnly, SameSite=Strict cookie (`Secure` in production). Passwords are hashed with scrypt. Sign-in is rate-limited.
- Sessions slide: you stay signed in while you're working, and are signed out after `SESSION_IDLE_MINUTES` (default 120) without activity, or `SESSION_HOURS` (default 168) after signing in, whichever comes first. While you type in the dashboard it checks in every few minutes, so writing a long post doesn't count as idle. If a session does run out, signing in again brings back whatever you were editing. Changing your password signs out every other browser.
- Admin write requests require an `X-Requested-With` header, which blocks CSRF.
- Forms are rate-limited (10 per 15 minutes per IP) and include a honeypot field.
- Resumes are stored outside the web root, so only signed-in admins can download them. They must be PDF/DOC/DOCX, max 5 MB.
- Image uploads can't be SVG, because SVG can contain scripts.
- Raw HTML in blog Markdown is shown as text, never executed.
- Only `css/`, `js/`, `assets/`, the top-level `*.html` pages, `robots.txt` and `sitemap.xml` are served. `pages/`, `templates/`, `server/` and the build scripts are not reachable.
