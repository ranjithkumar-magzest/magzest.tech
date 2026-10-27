/* =========================================================
   Magzest server — server-side rendering of CMS content
   The built pages (careers.html, blog.html, portfolio.html,
   vlogs.html)
   keep their hard-coded content between marker comments:

     <!-- cms:jobs --> …static fallback… <!-- /cms:jobs -->

   When served through this server, the region is replaced
   with content from the database. Opened as plain static
   files, the fallback still shows — nothing breaks.

   Markup here mirrors pages/*.html exactly; this folder is
   included in Tailwind's @source so its classes get built.
   ========================================================= */

import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { config } from "../config.js";
import { db } from "../db.js";
import { escapeHtml as e, videoSource } from "../util.js";

// Raw HTML typed into a post body is shown as text, not executed, so a
// post can never inject scripts into the site. Markdown covers formatting.
marked.use({ renderer: { html: ({ text }) => e(text) } });

// Links and images may only point at web pages, email/phone or this site,
// never "javascript:" or "data:" URLs that would run code when clicked.
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
function safeUrl(href) {
  try {
    // Check what the browser will see: entities decoded ("java&#115;cript:")
    // and the whitespace/control characters it ignores removed.
    const url = String(href)
      .replace(/&#x([0-9a-f]+);?/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);?/g, (m, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&colon;/gi, ":")
      .replace(/&(tab|newline);/gi, "")
      .replace(/[\u0000-\u0020]/g, "");
    // Any other entity before the path is suspicious, so refuse it.
    if (url.split(/[/?#]/)[0].includes("&")) return false;
    return SAFE_PROTOCOLS.has(new URL(url, "https://relative.invalid/").protocol);
  } catch {
    return false;
  }
}
marked.use({
  walkTokens(token) {
    if ((token.type === "link" || token.type === "image") && !safeUrl(token.href)) token.href = "#";
  },
});

/* ---------- Careers ---------- */

function renderJobs() {
  const jobs = db.prepare("SELECT * FROM jobs WHERE is_open = 1 ORDER BY sort_order, id").all();
  if (!jobs.length) {
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-8 text-center md:col-span-2" data-aos="fade-up">
        <h3 class="font-heading font-semibold">No open roles right now</h3>
        <p class="text-sm text-slate-500 mt-2">We're always happy to meet great people — send us your CV using the form below and we'll keep it on file.</p>
      </div>
`;
  }
  return (
    "\n" +
    jobs
      .map((job, i) => {
        const span = jobs.length % 2 === 1 && i === jobs.length - 1 ? " md:col-span-2" : "";
        const delay = i % 4 ? ` data-aos-delay="${(i % 4) * 100}"` : "";
        const meta = [job.location, job.employment_type, job.stack].filter(Boolean).map(e).join(" · ");
        return `
      <div class="card-tilt bg-white border border-slate-200 rounded-2xl p-6 flex items-center justify-between gap-4 flex-wrap${span}" data-aos="fade-up"${delay}>
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 rounded-md bg-blue-900 text-white flex items-center justify-center flex-shrink-0"><i data-lucide="${e(job.icon)}" class="w-6 h-6"></i></div>
          <div>
            <h3 class="font-heading font-semibold">${e(job.title)}</h3>
            <p class="text-sm text-slate-500">${meta}</p>
          </div>
        </div>
        <button data-apply-for="${e(job.title)}" class="btn-glow bg-blue-900 hover:bg-blue-950 text-white text-sm font-semibold px-5 py-2.5 rounded-md">Apply Now</button>
      </div>
`;
      })
      .join("") +
    "\n    "
  );
}

function renderJobOptions() {
  const titles = db.prepare("SELECT title FROM jobs WHERE is_open = 1 ORDER BY sort_order, id").all().map((j) => j.title);
  return "\n" + [...titles, "Other"].map((t) => `            <option>${e(t)}</option>\n`).join("") + "          ";
}

/* ---------- Blog ---------- */

// Articles can also be hand-written pages built from pages/<slug>.html
// (e.g. blog-seo-checklist-2026.html). Such a post links to that page
// instead of the database-rendered /blog/<slug>.
export function staticPostPath(slug) {
  const file = `${slug}.html`;
  return /^[a-z0-9-]+$/.test(slug) && fs.existsSync(path.join(config.siteRoot, file)) ? file : null;
}

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";

function listedPosts() {
  return db
    .prepare(
      `SELECT * FROM posts WHERE status = 'published' OR status = 'coming_soon'
       ORDER BY status = 'coming_soon', COALESCE(published_at, created_at) DESC`
    )
    .all();
}

function renderPostCards() {
  const posts = listedPosts();
  if (!posts.length) return "\n";
  return (
    "\n" +
    posts
      .map((post, i) => {
        const delay = i % 3 ? ` data-aos-delay="${(i % 3) * 100}"` : "";
        const img = post.cover_image
          ? `<img src="${e(post.cover_image)}" alt="${e(post.title)}" loading="lazy" decoding="async" class="h-44 w-full object-cover" />`
          : `<div class="h-44 w-full gradient-bg" aria-hidden="true"></div>`;
        if (post.status === "coming_soon") {
          return `      <div class="relative rounded-2xl overflow-hidden border border-slate-200 bg-white opacity-80" data-aos="fade-up"${delay}>
        <span class="absolute top-3 right-3 z-10 text-[11px] font-semibold uppercase bg-slate-900/80 text-white px-2.5 py-1 rounded-full">Coming soon</span>
        ${img}
        <div class="p-6">
          <span class="text-xs font-semibold uppercase text-slate-500">${e(post.category)}</span>
          <h3 class="font-heading font-semibold text-lg mt-2">${e(post.title)}</h3>
        </div>
      </div>
`;
        }
        return postCard(post, img, delay);
      })
      .join("") +
    "    "
  );
}

function postCard(post, img, delay = "") {
  return `      <a href="${e(staticPostPath(post.slug) || `blog/${post.slug}`)}" class="group card-tilt relative block rounded-2xl overflow-hidden border border-slate-200 bg-white" data-aos="fade-up"${delay}>
        ${img}
        <div class="p-6">
          <span class="text-xs font-semibold uppercase text-slate-500">${e(post.category)}</span>
          <h3 class="font-heading font-semibold text-lg mt-2 group-hover:underline">${e(post.title)}</h3>
          ${post.excerpt ? `<p class="text-sm text-slate-600 mt-2">${e(post.excerpt)}</p>` : ""}
          <p class="text-xs text-slate-400 mt-4 inline-flex items-center gap-1.5">${formatDate(post.published_at)} · Read article <i data-lucide="arrow-right" class="w-3 h-3 icon-slide"></i></p>
        </div>
      </a>
`;
}

// "Keep reading" at the end of an article: other published posts, same
// category first, then the newest. Gives readers somewhere to go next.
function renderRelatedPosts(slug) {
  const current = db.prepare("SELECT category FROM posts WHERE slug = ?").get(slug);
  const others = db
    .prepare("SELECT * FROM posts WHERE status = 'published' AND slug != ? ORDER BY COALESCE(published_at, created_at) DESC")
    .all(slug);
  const sameCategory = (p) => Boolean(current?.category) && p.category === current.category;
  const posts = [...others.filter(sameCategory), ...others.filter((p) => !sameCategory(p))].slice(0, 3);
  if (!posts.length) return "\n";
  const cards = posts.map((post, i) => {
    const img = post.cover_image
      ? `<img src="${e(post.cover_image)}" alt="" loading="lazy" decoding="async" class="h-36 w-full object-cover" />`
      : `<div class="h-36 w-full gradient-bg" aria-hidden="true"></div>`;
    return postCard(post, img, i ? ` data-aos-delay="${i * 100}"` : "");
  });
  return `
    <section class="mt-16" aria-labelledby="related-heading">
      <h2 id="related-heading" class="font-heading text-2xl font-bold">Keep reading</h2>
      <div class="grid md:grid-cols-3 gap-6 mt-6">
${cards.join("")}      </div>
    </section>
    `;
}

/* ---------- Portfolio ---------- */

function visibleProjects() {
  return db.prepare("SELECT * FROM projects WHERE is_visible = 1 ORDER BY sort_order, id").all();
}

function renderProjectFilters() {
  const seen = new Map();
  for (const p of visibleProjects()) if (!seen.has(p.category)) seen.set(p.category, p.category_label);
  const button = (filter, label, active) =>
    `      <button class="filter-btn${active ? " active" : ""} glass-card rounded-full px-5 py-2 text-sm font-semibold" data-filter="${e(filter)}">${e(label)}</button>\n`;
  return "\n" + button("all", "All Projects", true) + [...seen].map(([c, l]) => button(c, l)).join("") + "    ";
}

function renderProjects() {
  const indent = (html, pad) =>
    html
      .split("\n")
      .map((line) => (line ? pad + line : line))
      .join("\n");
  return (
    "\n" +
    visibleProjects()
      .map((p, i) => {
        const delay = i % 6 ? ` data-aos-delay="${(i % 6) * 100}"` : "";
        const thumb = p.image
          ? `        <img src="${e(p.image)}" alt="${e(p.title)}" loading="lazy" decoding="async" class="h-36 w-full object-cover" />`
          : indent(p.mockup_html || `<div class="h-36 w-full gradient-bg" aria-hidden="true"></div>`, "        ");
        const tags = p.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => `            <span class="text-[11px] bg-slate-100 rounded-full px-2.5 py-1">${e(t)}</span>\n`)
          .join("");
        return `
      <div class="project-card card-tilt rounded-2xl overflow-hidden border border-slate-200 bg-white" data-category="${e(p.category)}" data-aos="fade-up"${delay}>
${thumb}
        <div class="p-4">
          <span class="text-xs uppercase tracking-wide text-blue-900 font-semibold">${e(p.kind)} · ${e(p.category_label)}</span>
          <h3 class="font-heading text-base font-bold mt-1">${e(p.title)}</h3>
          <p class="text-xs text-slate-600 mt-1">${e(p.description)}</p>
          <div class="flex flex-wrap gap-1.5 mt-3">
${tags}          </div>
          <a href="contact.html" class="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-900">Discuss a similar project <i data-lucide="arrow-right" class="w-3 h-3 icon-slide"></i></a>
        </div>
      </div>
`;
      })
      .join("") +
    "\n    "
  );
}

/* ---------- Vlogs ---------- */

function renderVlogPlayer(vlog) {
  const source = videoSource(vlog.video_url);
  if (!source) return `<div class="w-full h-full gradient-bg" aria-hidden="true"></div>`;
  if (source.type === "file") {
    const poster = vlog.thumbnail ? ` poster="${e(vlog.thumbnail)}"` : "";
    return `<video src="${e(source.src)}"${poster} controls playsinline preload="metadata" class="w-full h-full object-cover bg-slate-900"></video>`;
  }
  // Click-to-play: a YouTube/Vimeo iframe pulls in ~0.5-1 MB of player
  // script, so show the thumbnail and let main.js swap in the iframe on
  // click. Without JS the link simply opens the video on YouTube/Vimeo.
  const embed = source.src + (source.src.includes("?") ? "&" : "?") + "autoplay=1";
  const thumb = vlog.thumbnail || source.thumb;
  const poster = thumb
    ? `<img src="${e(thumb)}" alt="" loading="lazy" decoding="async" class="absolute inset-0 w-full h-full object-cover" />`
    : `<span class="absolute inset-0 gradient-bg" aria-hidden="true"></span>`;
  return `<a href="${e(vlog.video_url)}" target="_blank" rel="noopener noreferrer" data-video-embed="${e(embed)}" data-video-title="${e(vlog.title)}" aria-label="Play video: ${e(vlog.title)}" class="group relative block w-full h-full">
          ${poster}
          <span class="absolute inset-0 flex items-center justify-center bg-slate-900/20 group-hover:bg-slate-900/35 transition">
            <span class="w-16 h-16 rounded-full bg-white/95 text-blue-900 flex items-center justify-center shadow-lg group-hover:scale-110 transition"><i data-lucide="play" class="w-7 h-7 ml-1"></i></span>
          </span>
        </a>`;
}

function renderVlogs() {
  const vlogs = db.prepare("SELECT * FROM vlogs WHERE status = 'published' ORDER BY COALESCE(published_at, created_at) DESC").all();
  if (!vlogs.length) {
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-10 text-center md:col-span-2" data-aos="fade-up">
        <h3 class="font-heading font-semibold text-lg">Our first vlog is on its way</h3>
        <p class="text-sm text-slate-500 mt-2">Behind-the-scenes videos, project walkthroughs and tips from the Magzest team are coming soon.</p>
      </div>
    `;
  }
  return (
    "\n" +
    vlogs
      .map((vlog, i) => {
        const delay = i % 2 ? ` data-aos-delay="100"` : "";
        return `      <article class="rounded-2xl overflow-hidden border border-slate-200 bg-white" data-aos="fade-up"${delay}>
        <div class="aspect-video bg-slate-900">${renderVlogPlayer(vlog)}</div>
        <div class="p-6">
          ${vlog.category ? `<span class="text-xs font-semibold uppercase text-slate-500">${e(vlog.category)}</span>` : ""}
          <h3 class="font-heading font-semibold text-lg mt-2">${e(vlog.title)}</h3>
          ${vlog.description ? `<p class="text-sm text-slate-600 mt-2">${e(vlog.description)}</p>` : ""}
          <p class="text-xs text-slate-400 mt-4">${formatDate(vlog.published_at)}</p>
        </div>
      </article>
`;
      })
      .join("") +
    "    "
  );
}

/* ---------- Marker injection ---------- */

const RENDERERS = {
  jobs: renderJobs,
  "job-options": renderJobOptions,
  posts: renderPostCards,
  "project-filters": renderProjectFilters,
  projects: renderProjects,
  vlogs: renderVlogs,
  "related-posts": ({ slug }) => (slug ? renderRelatedPosts(slug) : "\n"),
};

// context: { slug } of the page being served, for page-specific regions.
export function injectCms(html, context = {}) {
  return html.replace(/<!-- cms:([a-z-]+) -->([\s\S]*?)<!-- \/cms:\1 -->/g, (match, name) => {
    const render = RENDERERS[name];
    if (!render) return match;
    try {
      return `<!-- cms:${name} -->${render(context)}<!-- /cms:${name} -->`;
    } catch (err) {
      // Fall back to the static content rather than breaking the page.
      console.error(`CMS render "${name}" failed:`, err);
      return match;
    }
  });
}

/* ---------- Pages rendered from templates (blog posts, 404) ---------- */

function readTemplate(name) {
  return fs.readFileSync(path.join(config.siteRoot, "templates", name), "utf8");
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

// These pages live at /blog/<slug>, but every link and asset in the site
// is relative ("css/…", "index.html"), so they get <base href="/">.
// noindex: for pages search engines shouldn't list (404, draft previews).
// They get no canonical link either, as it would name a page that isn't real.
function renderTemplatePage({ title, description, urlPath, main, ogType = "website", ogImage = "", noindex = false }) {
  let head = fill(readTemplate("head-main.html"), {
    // The browser tab shows only the brand; the descriptive title stays in og:title.
    TITLE: "MagZest",
    DESCRIPTION: e(description),
    PATH: e(urlPath),
    URL_PATH: e(urlPath),
    OG_TITLE: e(title),
    OG_DESCRIPTION: e(description),
    KEYWORDS_LINE: "",
  })
    .replace(/<head>\r?\n/, '<head>\n<base href="/" />\n')
    .replace('content="website"', `content="${ogType}"`)
    .replace('href="#main-content"', `href="/${e(urlPath)}#main-content"`);
  if (noindex) head = head.replace(/<link rel="canonical"[^>]*>\r?\n/, '<meta name="robots" content="noindex" />\n');
  if (ogImage) head = head.replace("<meta property=\"og:site_name\"", `<meta property="og:image" content="${e(ogImage)}" />\n<meta property="og:site_name"`);
  const foot = fill(readTemplate("foot.html"), { EXTRA_SCRIPT_TAG: "" });
  return head + main + "\n" + foot;
}

export function renderPostPage(slug, { preview = false } = {}) {
  const post = db.prepare("SELECT * FROM posts WHERE slug = ?").get(slug);
  if (!post || (post.status !== "published" && !preview)) return null;

  const absolute = (src) => (/^https?:/.test(src) ? src : `${config.siteUrl}/${src.replace(/^\//, "")}`);
  const draftBanner =
    post.status !== "published"
      ? `<div class="mb-8 rounded-md bg-amber-100 text-amber-900 text-sm px-4 py-3">Preview — this post is <b>${post.status === "draft" ? "a draft" : "marked coming soon"}</b> and isn't visible to the public.</div>`
      : "";
  const words = String(post.body || "").split(/\s+/).filter(Boolean).length;
  const readingTime = `${Math.max(1, Math.round(words / 200))} min read`;
  const image = post.cover_image ? absolute(post.cover_image) : "";
  // Same BlogPosting markup the hand-written articles carry, for rich results.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt || undefined,
    image: image || undefined,
    datePublished: post.published_at || undefined,
    dateModified: post.updated_at,
    author: { "@type": "Organization", name: "Magzest", url: `${config.siteUrl}/` },
    publisher: { "@type": "Organization", name: "Magzest", logo: { "@type": "ImageObject", url: `${config.siteUrl}/assets/images/logo.svg` } },
    mainEntityOfPage: `${config.siteUrl}/blog/${post.slug}`,
  }).replace(/</g, "\\u003c");
  const cover = post.cover_image
    ? `<img src="${e(post.cover_image)}" alt="${e(post.title)}" decoding="async" class="mt-10 w-full rounded-2xl object-cover max-h-[420px]" />`
    : "";
  const main = `
<script type="application/ld+json">${jsonLd}</script>
<article class="pt-40 pb-24">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
    ${draftBanner}
    <a href="blog.html" class="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"><i data-lucide="arrow-left" class="w-4 h-4"></i> All articles</a>
    <span class="badge-eyebrow block mt-8 text-xs font-semibold uppercase text-blue-900">${e(post.category)}</span>
    <h1 class="font-heading text-4xl sm:text-5xl font-bold mt-3">${e(post.title)}</h1>
    <p class="mt-4 text-sm text-slate-500">${[formatDate(post.published_at), readingTime].filter(Boolean).join(" · ")}</p>
    ${cover}
    <div class="post-body mt-10">
${marked.parse(post.body || "")}
    </div>
    <div class="mt-16 border-t border-slate-200 pt-8 flex flex-wrap items-center justify-between gap-4">
      <p class="text-slate-600">Want help putting this into practice?</p>
      <a href="contact.html" class="btn-glow inline-flex items-center gap-2 bg-blue-900 hover:bg-blue-950 text-white font-semibold px-6 py-3 rounded-md">Talk to our team <i data-lucide="arrow-right" class="w-4 h-4 icon-slide"></i></a>
    </div>
    ${renderRelatedPosts(post.slug)}
  </div>
</article>
`;
  return renderTemplatePage({
    title: `${post.title} | Magzest Blog`,
    description: post.excerpt || `${post.title} — from the Magzest blog.`,
    urlPath: `blog/${post.slug}`,
    main,
    ogType: "article",
    ogImage: image,
    noindex: post.status !== "published",
  });
}

export function renderNotFoundPage(urlPath) {
  const main = `
<section class="pt-40 pb-32">
  <div class="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
    <span class="badge-eyebrow text-xs font-semibold uppercase text-blue-900 border border-slate-200 px-4 py-1.5 rounded-full">Error 404</span>
    <h1 class="font-heading text-4xl sm:text-5xl font-bold mt-6">Page not found</h1>
    <p class="mt-5 text-lg text-slate-600">The page you're looking for doesn't exist or has moved.</p>
    <a href="index.html" class="btn-glow mt-8 inline-flex items-center gap-2 bg-blue-900 hover:bg-blue-950 text-white font-semibold px-7 py-3.5 rounded-md">Back to home <i data-lucide="arrow-right" class="w-4 h-4 icon-slide"></i></a>
  </div>
</section>
`;
  return renderTemplatePage({
    title: "Page not found | Magzest",
    description: "This page could not be found.",
    urlPath: urlPath.replace(/^\//, ""),
    main,
    noindex: true,
  });
}

/* ---------- Sitemap: static pages + published posts ---------- */

export function renderSitemap() {
  const base = fs.readFileSync(path.join(config.siteRoot, "sitemap.xml"), "utf8");
  // Static article pages are already listed in sitemap.xml itself.
  const posts = db.prepare("SELECT slug, updated_at FROM posts WHERE status = 'published'").all().filter((p) => !staticPostPath(p.slug));
  const entries = posts
    .map(
      (p) => `  <url>
    <loc>${config.siteUrl}/blog/${e(p.slug)}</loc>
    <lastmod>${p.updated_at.slice(0, 10)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
`
    )
    .join("");
  return base.replace("</urlset>", entries + "</urlset>");
}
