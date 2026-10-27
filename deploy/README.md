# Deploying magzest.tech to Hostinger web hosting

The site is plain static files (HTML, CSS, JavaScript and images), so any web host can serve it. No Node.js, database or server program is needed.

- The contact form and the consultation booking go straight to **Zoho Bigin**.
- Job applications and newsletter sign-ups are emailed to contact@magzest.tech through **FormSubmit**, with contact leads copied to the team.
- The chat is **Zoho SalesIQ**, loaded on every page.

## 1. Build (on your PC)

Only needed after editing `pages/`, `templates/`, `js/*.js` or Tailwind classes:

```powershell
.\build.ps1
```

It rebuilds the CSS, the minified JavaScript, the pages and `.htaccess`. Rebuilding the pages and `.htaccess` needs only Node.js (`node build-html.mjs`, `node deploy\make-htaccess.mjs`); CSS and JavaScript need the tools described at the top of `build-css.ps1` and `build-js.ps1`.

## 2. Upload to `public_html`

In **hPanel → Websites → magzest.tech → File manager**, open `public_html` and upload:

| Upload | What it is |
| --- | --- |
| all top-level `*.html` files | the pages |
| `css/`, `js/`, `assets/` | styles, scripts, images |
| `favicon.ico`, `robots.txt`, `sitemap.xml` | |
| `.htaccess` | security headers (Content-Security-Policy, HSTS, clickjacking and MIME-sniffing protection) |

Don't upload `pages/`, `templates/`, `src/`, `deploy/`, the build scripts or the `server/` folder if one is still on your PC. They aren't part of the website.

If `public_html` already has a `.htaccess`, paste the `# BEGIN Magzest security headers` block into it instead of replacing the file. `.htaccess` starts with a dot, so in File manager turn on **Show hidden files** to see it.

## 3. Check the live site

- Open the site and a few pages, and check the icons and animations.
- Open the chat and check it loads past the spinner.
- Send a test from the contact form (check it appears in Bigin) and from the careers form (check the email and the attached resume arrive).
- Press F12 and look for red Content-Security-Policy errors in the Console.

## HTTPS

In **hPanel → Security → SSL**, install the free SSL certificate for the domain if it isn't already on. `.htaccess` tells browsers to always use HTTPS once the site has been visited over HTTPS.
