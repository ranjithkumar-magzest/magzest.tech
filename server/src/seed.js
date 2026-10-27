/* =========================================================
   Magzest server — first-run content import
   Copies the content that is hard-coded in pages/*.html
   into the database. Runs once (guarded by meta table).
   ========================================================= */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { nowIso } from "./util.js";

const JOBS = [
  { title: "Frontend Developer", location: "Remote", employment_type: "Full-time", stack: "React / Tailwind", icon: "layout" },
  { title: "Backend Developer", location: "Remote", employment_type: "Full-time", stack: "Node.js / PostgreSQL", icon: "server" },
  { title: "Mobile App Developer", location: "Remote", employment_type: "Full-time", stack: "Flutter / React Native", icon: "smartphone" },
  { title: "Marketing Executive", location: "Hybrid", employment_type: "Full-time", stack: "SEO / Social Media", icon: "megaphone" },
  { title: "HR & Talent Coordinator", location: "Remote", employment_type: "Full-time", stack: "Recruitment & Culture", icon: "user-round" },
];


const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

// Pull the blog cards out of the blog page source. Linked cards point at
// hand-written article pages (pages/blog-*.html) and become published
// posts with that slug; unlinked cards are "coming soon" teasers.
export function extractPosts(html) {
  const start = html.indexOf("<!-- cms:posts -->");
  const end = html.indexOf("<!-- /cms:posts -->");
  if (start < 0 || end < 0) return [];
  const region = html.slice(start, end);
  return [...region.matchAll(/<(a href="([^"]+)\.html"|div class="relative rounded-2xl)[\s\S]*?<\/(a|div)>\s*(?=<a |<div class="relative rounded-2xl|$)/g)].map((m) => {
    const card = m[0];
    const pick = (re) => (card.match(re) || [])[1];
    const title = decode(pick(/<h3[^>]*>([^<]+)<\/h3>/) || "");
    const date = pick(/>(\d{1,2} \w{3} \d{4}) ·/);
    return {
      slug: m[2] || title.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      title,
      category: decode(pick(/<span class="text-xs font-semibold uppercase[^"]*">([^<]+)<\/span>/) || ""),
      excerpt: decode(pick(/<p class="text-sm text-slate-600 mt-2">([^<]+)<\/p>/) || ""),
      cover_image: pick(/<img src="([^"]+)"/) || "",
      status: m[2] ? "published" : "coming_soon",
      published_at: m[2] && date ? new Date(date + " 12:00 UTC").toISOString() : null,
    };
  });
}

// Pull the six project cards (including their CSS dashboard mockups)
// out of the portfolio page source.
export function extractProjects(html) {
  const labels = {};
  for (const m of html.matchAll(/data-filter="([^"]+)">([^<]+)</g)) labels[m[1]] = decode(m[2]);

  return html
    .split('<div class="project-card')
    .slice(1)
    .map((chunk, i) => {
      const category = chunk.match(/data-category="([^"]+)"/)[1];
      const afterOpen = chunk.slice(chunk.indexOf(">") + 1);
      const mockup = afterOpen.slice(0, afterOpen.indexOf('<div class="p-4">'));
      const kindLabel = decode(chunk.match(/<span class="text-xs uppercase[^"]*">([^<]+)<\/span>/)[1]);
      return {
        title: decode(chunk.match(/<h3[^>]*>([^<]+)<\/h3>/)[1]),
        category,
        category_label: labels[category] || category,
        kind: kindLabel.split("·")[0].trim(),
        description: decode(chunk.match(/<p class="text-xs text-slate-600 mt-1">([^<]+)<\/p>/)[1]),
        tags: [...chunk.matchAll(/<span class="text-\[11px\][^"]*">([^<]+)<\/span>/g)].map((m) => decode(m[1])).join(", "),
        mockup_html: mockup
          .split("\n")
          .map((line) => line.replace(/^ {8}/, ""))
          .join("\n")
          .trim(),
        sort_order: i,
      };
    });
}

export function seedContent(db) {
  const now = nowIso();

  const insertJob = db.prepare(
    `INSERT INTO jobs (title, location, employment_type, stack, icon, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  JOBS.forEach((j, i) => insertJob.run(j.title, j.location, j.employment_type, j.stack, j.icon, i, now, now));

  const blogPage = path.join(config.siteRoot, "pages", "blog.html");
  if (fs.existsSync(blogPage)) {
    const insertPost = db.prepare(
      `INSERT INTO posts (slug, title, category, excerpt, cover_image, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of extractPosts(fs.readFileSync(blogPage, "utf8"))) {
      insertPost.run(p.slug, p.title, p.category, p.excerpt, p.cover_image, p.status, p.published_at, now, now);
    }
  }

  const portfolioPage = path.join(config.siteRoot, "pages", "portfolio.html");
  if (fs.existsSync(portfolioPage)) {
    const insertProject = db.prepare(
      `INSERT INTO projects (title, category, category_label, kind, description, tags, mockup_html, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of extractProjects(fs.readFileSync(portfolioPage, "utf8"))) {
      insertProject.run(p.title, p.category, p.category_label, p.kind, p.description, p.tags, p.mockup_html, p.sort_order, now, now);
    }
  }
}
