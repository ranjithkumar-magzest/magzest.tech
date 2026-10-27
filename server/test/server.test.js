import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer, browser, signIn, sleep, ADMIN } from "./helpers.js";

// A 6-second idle window keeps the session-expiry tests quick.
const IDLE_SECONDS = 6;
let server;
// Shared signed-in admin: sign-in is rate limited to 10 attempts per 15 minutes.
let admin;

before(async () => {
  server = await startServer({ SESSION_IDLE_MINUTES: String(IDLE_SECONDS / 60) });
  admin = browser(server.base);
  await signIn(server, admin);
});

// Uses the shared session, signing in again if it idled out (e.g. during
// the inactivity test).
const adminRequest = async (...args) => {
  if ((await admin.request("GET", "/api/admin/me")).status === 401) await signIn(server, admin);
  return admin.request(...args);
};
after(() => server?.stop());

/* ---------- Sign-in and sessions ---------- */

test("wrong password is refused", async () => {
  const b = browser(server.base);
  const res = await b.request("POST", "/api/admin/login", { json: { email: ADMIN.email, password: "nope-nope-nope" } });
  assert.equal(res.status, 401);
  assert.equal(b.cookies.size, 0);
});

test("unknown email gets the same answer as a wrong password", async () => {
  const res = await browser(server.base).request("POST", "/api/admin/login", { json: { email: "nobody@example.test", password: "x" } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "Wrong email or password.");
});

test("password + emailed code signs in", async () => {
  const b = browser(server.base);
  const res = await signIn(server, b);
  assert.equal(res.status, 200);
  const me = await b.request("GET", "/api/admin/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.admin.email, ADMIN.email);
  assert.ok(me.body.expiresAt > Date.now());
});

test("state-changing admin requests need the X-Requested-With header", async () => {
  const res = await adminRequest("POST", "/api/admin/content/jobs", { json: { title: "x" }, headers: { "X-Requested-With": "other" } });
  assert.equal(res.status, 403);
});

test("activity keeps the session alive; inactivity ends it", async () => {
  const b = browser(server.base);
  await signIn(server, b);
  // Stay active for longer than the idle window.
  for (let t = 0; t < IDLE_SECONDS + 2; t += 2) {
    await sleep(2000);
    assert.equal((await b.request("GET", "/api/admin/me")).status, 200, `signed out after ${t + 2}s of activity`);
  }
  // Then go quiet for longer than the idle window.
  await sleep((IDLE_SECONDS + 1) * 1000);
  assert.equal((await b.request("GET", "/api/admin/me")).status, 401);
});

test("tampered or old-format session cookies are rejected", async () => {
  const b = browser(server.base);
  await signIn(server, b);
  const [id, issued, seen, sig] = b.cookies.get("mz_admin").split(".");
  b.cookies.set("mz_admin", [id, issued, String(Date.now() + 1e9), sig].join("."));
  assert.equal((await b.request("GET", "/api/admin/me")).status, 401);
  b.cookies.set("mz_admin", `${id}.${Date.now() + 1e9}.${sig}`);
  assert.equal((await b.request("GET", "/api/admin/me")).status, 401);
  b.cookies.set("mz_admin", "%E0%A4%A");
  assert.equal((await b.request("GET", "/api/admin/me")).status, 401);
});

/* ---------- Forms ---------- */

test("contact form is saved, encrypted at rest, and readable in the admin", async () => {
  const visitor = browser(server.base);
  const res = await visitor.request("POST", "/api/forms/contact", {
    form: { first_name: "Asha", last_name: "Rao", email: "asha@example.test", phone: "9999999999", message: "Need a website" },
  });
  assert.equal(res.status, 200);

  const raw = new DatabaseSync(path.join(server.dataDir, "magzest.db"), { readOnly: true });
  const row = raw.prepare("SELECT name, email, data FROM submissions WHERE type = 'contact' ORDER BY id DESC LIMIT 1").get();
  raw.close();
  for (const value of Object.values(row)) assert.match(value, /^enc1:/);
  assert.doesNotMatch(JSON.stringify(row), /Asha|asha@example/);

  const list = await adminRequest("GET", "/api/admin/submissions/contact");
  const item = list.body.items.find((i) => i.email === "asha@example.test");
  assert.equal(item.name, "Asha Rao");
  assert.equal(item.data.message, "Need a website");
});

test("contact form validates required fields", async () => {
  const res = await browser(server.base).request("POST", "/api/forms/contact", { form: { first_name: "A", email: "not-an-email" } });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.last_name);
  assert.ok(res.body.errors.email);
});

test("honeypot submissions are accepted but not stored", async () => {
  const before = (await adminRequest("GET", "/api/admin/submissions/contact")).body.items.length;
  const res = await browser(server.base).request("POST", "/api/forms/contact", { form: { last_name: "Bot", _honey: "x" } });
  assert.equal(res.status, 200);
  assert.equal((await adminRequest("GET", "/api/admin/submissions/contact")).body.items.length, before);
});

/* ---------- Content API ---------- */

test("an invalid publish date is a 400, not a server error", async () => {
  const res = await adminRequest("POST", "/api/admin/content/posts", { json: { title: "Bad date", published_at: "not a date" } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid date/);
});

/* ---------- Dashboard ---------- */

test("dashboard lists what needs doing, newest leads and system problems first", async () => {
  await browser(server.base).request("POST", "/api/forms/contact", { form: { first_name: "Ravi", last_name: "Kumar", message: "Quote for an app please" } });
  const res = await adminRequest("GET", "/api/admin/dashboard");
  assert.equal(res.status, 200);
  const d = res.body;
  assert.equal(d.me, ADMIN.email);
  assert.match(d.today, /^\d{4}-\d{2}-\d{2}$/);

  const lead = d.attention.find((a) => a.kind === "lead" && a.title === "New enquiry from Ravi Kumar");
  assert.ok(lead, "unread enquiry is listed by name");
  assert.match(lead.detail, /Quote for an app/);
  assert.match(lead.href, /^#\/leads\/\d+$/);

  // The test server has no SMTP, which is urgent and sorts to the top.
  assert.equal(d.attention[0].title, "Email isn't set up");
  const tones = d.attention.map((a) => ({ red: 0, amber: 1, blue: 2 })[a.tone]);
  assert.deepEqual(tones, [...tones].sort((a, b) => a - b));

  assert.equal(d.week.daily.length, 7);
  assert.ok(d.week.enquiries.current >= 1);
  for (const key of ["visitors", "views", "enquiries", "applications", "subscribers"]) assert.equal(typeof d.week[key].previous, "number");
  assert.ok(d.recent.some((r) => r.name === "Ravi Kumar"));
  assert.equal(typeof d.live.posts, "number");
  assert.ok("new" in d.stages && "won" in d.stages);
});

test("dashboard is admin-only", async () => {
  assert.equal((await browser(server.base).request("GET", "/api/admin/dashboard")).status, 401);
});

/* ---------- Public pages ---------- */

test("published posts get reading time, structured data and related posts; drafts stay private", async () => {
  const body = Array(450).fill("word").join(" ");
  const post = await adminRequest("POST", "/api/admin/content/posts", { json: { title: "Test post one", category: "Web Development", body, status: "published" } });
  assert.equal(post.status, 200);
  const draft = await adminRequest("POST", "/api/admin/content/posts", { json: { title: "Secret draft", body: "shh", status: "draft" } });

  const page = await browser(server.base).request("GET", `/blog/${post.body.item.slug}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /2 min read/);
  assert.match(page.body, /"@type":"BlogPosting"/);
  assert.match(page.body, /Keep reading/);
  assert.match(page.body, /<link rel="canonical" href="https:\/\/www\.magzest\.tech\/blog\/test-post-one"/);

  assert.equal((await browser(server.base).request("GET", `/blog/${draft.body.item.slug}`)).status, 404);
  const preview = await adminRequest("GET", `/blog/${draft.body.item.slug}?preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.body, /<meta name="robots" content="noindex"/);
  assert.doesNotMatch(preview.body, /rel="canonical"/);
});

test("hand-written articles link to other articles", async () => {
  const res = await browser(server.base).request("GET", "/blog-seo-checklist-2026.html");
  assert.equal(res.status, 200);
  const related = res.body.match(/<!-- cms:related-posts -->([\s\S]*?)<!-- \/cms:related-posts -->/)[1];
  assert.match(related, /Keep reading/);
  assert.doesNotMatch(related, /href="blog-seo-checklist-2026\.html"/, "an article shouldn't recommend itself");
});

test("404 page is not indexable and has no canonical link", async () => {
  const res = await browser(server.base).request("GET", "/no-such-page.html");
  assert.equal(res.status, 404);
  assert.match(res.body, /<meta name="robots" content="noindex"/);
  assert.doesNotMatch(res.body, /rel="canonical"/);
});

test("text responses are gzip-compressed", async () => {
  const res = await fetch(server.base + "/css/tailwind.css", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
});

test("pages carry the security headers", async () => {
  const res = await fetch(server.base + "/");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(res.headers.get("x-powered-by"), null);
});

// Last: it signs out every other session, including the shared admin.
test("changing the password signs out other sessions but not this one", async () => {
  const laptop = browser(server.base);
  const phone = browser(server.base);
  await signIn(server, laptop);
  await signIn(server, phone);
  const newPassword = "an even better passphrase";
  const res = await laptop.request("POST", "/api/admin/password", { json: { current: ADMIN.password, next: newPassword } });
  assert.equal(res.status, 200);
  assert.equal((await laptop.request("GET", "/api/admin/me")).status, 200);
  assert.equal((await phone.request("GET", "/api/admin/me")).status, 401);
  // Put it back for the other tests.
  await laptop.request("POST", "/api/admin/password", { json: { current: newPassword, next: ADMIN.password } });
});
