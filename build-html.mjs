/*
 * Regenerates the flat, deployable HTML pages (index.html, about.html, ...)
 * from templates/*.html + pages/*.html. Run after editing anything in
 * pages/ or templates/:
 *
 *   node build-html.mjs
 *
 * pages/<name>.html format:
 *   KEY: value       (front-matter, see keys below)
 *   ...
 *   ---
 *   <main-content>   (everything that goes inside <main id="main-content">)
 *
 * Front-matter keys:
 *   TITLE, DESCRIPTION, PATH, TEMPLATE (main|legal) - required
 *   KEYWORDS, OG_TITLE, OG_DESCRIPTION, EXTRA_SCRIPT - optional
 *
 * profile.html is hand-authored outside this system (different layout,
 * no header/footer injection, no AOS) and is left untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(ROOT, "pages");
const TEMPLATES_DIR = path.join(ROOT, "templates");

// Pages may be saved with CRLF line endings; work in LF throughout.
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function parsePage(file) {
  const text = read(file);
  const split = text.indexOf("\n---\n");
  const front = text.slice(0, split);
  const meta = {};
  for (const line of front.trim().split("\n")) {
    const colon = line.indexOf(":");
    const key = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1);
    meta[key.trim()] = value.trim();
  }
  meta.MAIN = text.slice(split + 5).replace(/\n+$/, "");
  return meta;
}

const render = (template, values) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{{${key}}}`, value), template);

function build(meta, templates) {
  const values = {
    TITLE: meta.TITLE,
    DESCRIPTION: meta.DESCRIPTION,
    PATH: meta.PATH,
    // Homepage is canonicalised to the bare domain, not /index.html
    URL_PATH: meta.PATH === "index.html" ? "" : meta.PATH,
    OG_TITLE: meta.OG_TITLE || meta.TITLE,
    OG_DESCRIPTION: meta.OG_DESCRIPTION || meta.DESCRIPTION,
    KEYWORDS_LINE: meta.KEYWORDS ? `<meta name="keywords" content="${meta.KEYWORDS}" />\n` : "",
  };
  const head = render(meta.TEMPLATE === "legal" ? templates.legal : templates.main, values);

  const extra = meta.EXTRA_SCRIPT;
  const foot = render(templates.foot, {
    EXTRA_SCRIPT_TAG: extra ? `<script defer src="js/${extra}.min.js?v=6"></script>\n` : "",
  });

  return head + meta.MAIN + "\n" + foot;
}

const templates = {
  main: read(path.join(TEMPLATES_DIR, "head-main.html")),
  legal: read(path.join(TEMPLATES_DIR, "head-legal.html")),
  foot: read(path.join(TEMPLATES_DIR, "foot.html")),
};

for (const name of fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html")).sort()) {
  const meta = parsePage(path.join(PAGES_DIR, name));
  fs.writeFileSync(path.join(ROOT, meta.PATH), build(meta, templates));
  console.log(`Built ${meta.PATH}`);
}
