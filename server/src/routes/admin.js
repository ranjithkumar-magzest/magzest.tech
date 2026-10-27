/* =========================================================
   Magzest server — admin API (/api/admin/*)
   Everything except /login requires a signed-in admin.
   ========================================================= */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { db } from "../db.js";
import { requireAdmin, setSessionCookie, clearSessionCookie, verifyPassword, hashPassword, touchSession, revokeOtherSessions, startLoginChallenge, verifyLoginChallenge } from "../auth.js";
import { verifyMailer, sendLoginCode } from "../mailer.js";
import { EMAIL_RE, str, slugify, toCsv, nowIso, videoSource } from "../util.js";
import { encrypt, decryptRow, decryptBuffer } from "../crypto.js";

export const adminRouter = express.Router();
adminRouter.use(express.json({ limit: "1mb" }));

/* ---------- Auth ---------- */

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, error: "Too many sign-in attempts. Try again in 15 minutes." },
});

// "j***@magzest.in" — enough to recognise the mailbox, not to harvest it.
const maskEmail = (email) => email.replace(/^(.)[^@]*(@.*)$/, (m, first, domain) => `${first}***${domain}`);

adminRouter.post("/login", loginLimiter, async (req, res) => {
  const email = str(req.body?.email, 200);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const admin = db.prepare("SELECT id, email, password_hash FROM admins WHERE email = ?").get(email);
  if (!verifyPassword(password, admin?.password_hash)) {
    return res.status(401).json({ ok: false, error: "Wrong email or password." });
  }
  if (!config.admin.mfa) {
    setSessionCookie(res, admin.id);
    return res.json({ ok: true, admin: { id: admin.id, email: admin.email } });
  }
  // Step 2: the password alone grants nothing until the emailed code is entered.
  const challenge = startLoginChallenge(res, admin.id);
  const mail = await sendLoginCode({ to: admin.email, code: challenge.code, ip: req.ip });
  if (!mail.sent) {
    challenge.cancel();
    return res.status(503).json({ ok: false, error: `Couldn't email your sign-in code (${mail.error}). Check the SMTP settings in server/.env.` });
  }
  res.json({ ok: true, mfa: true, sentTo: maskEmail(admin.email) });
});

const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, error: "Too many attempts. Try again in 15 minutes." },
});

adminRouter.post("/login/verify", codeLimiter, (req, res) => {
  const result = verifyLoginChallenge(req, res, req.body?.code);
  if (result.error) return res.status(401).json({ ok: false, error: result.error, restart: Boolean(result.restart) });
  setSessionCookie(res, result.admin.id);
  res.json({ ok: true, admin: result.admin });
});

adminRouter.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Also the admin UI's keep-alive: calling it counts as activity.
adminRouter.get("/me", (req, res) => {
  const session = touchSession(req, res);
  if (!session) return res.status(401).json({ ok: false });
  res.json({ ok: true, admin: session.admin, expiresAt: session.expiresAt });
});

adminRouter.use(requireAdmin);

adminRouter.post("/password", (req, res) => {
  const { current, next } = req.body || {};
  const row = db.prepare("SELECT password_hash FROM admins WHERE id = ?").get(req.admin.id);
  if (!verifyPassword(String(current || ""), row.password_hash)) {
    return res.status(400).json({ ok: false, error: "Current password is wrong." });
  }
  if (typeof next !== "string" || next.length < 10) {
    return res.status(400).json({ ok: false, error: "New password must be at least 10 characters." });
  }
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(next), req.admin.id);
  revokeOtherSessions(res, req.admin.id);
  res.json({ ok: true });
});

adminRouter.get("/admins", (req, res) => {
  res.json({ ok: true, items: db.prepare("SELECT id, email, created_at FROM admins ORDER BY id").all() });
});

adminRouter.post("/admins", (req, res) => {
  const email = str(req.body?.email, 200);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: "Enter a valid email." });
  if (password.length < 10) return res.status(400).json({ ok: false, error: "Password must be at least 10 characters." });
  if (db.prepare("SELECT 1 FROM admins WHERE email = ?").get(email)) {
    return res.status(400).json({ ok: false, error: "That admin already exists." });
  }
  db.prepare("INSERT INTO admins (email, password_hash, created_at) VALUES (?, ?, ?)").run(email, hashPassword(password), nowIso());
  res.json({ ok: true });
});

adminRouter.delete("/admins/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.admin.id) return res.status(400).json({ ok: false, error: "You can't remove your own account." });
  db.prepare("DELETE FROM admins WHERE id = ?").run(id);
  res.json({ ok: true });
});

adminRouter.get("/mail-status", async (req, res) => {
  res.json({ ok: true, mail: { ...(await verifyMailer()), notifyTo: config.mail.notifyTo, autoReply: config.mail.autoReply } });
});

/* ---------- Dashboard ---------- */

adminRouter.get("/stats", (req, res) => {
  const counts = {};
  for (const row of db.prepare("SELECT type, status, COUNT(*) AS n FROM submissions GROUP BY type, status").all()) {
    counts[row.type] ??= { total: 0, new: 0 };
    counts[row.type].total += row.n;
    if (row.status === "new") counts[row.type].new += row.n;
  }
  const subscribers = db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'").get().n;
  const recent = db
    .prepare("SELECT id, type, name, email, status, created_at FROM submissions ORDER BY created_at DESC LIMIT 8")
    .all()
    .map((r) => decryptRow("submissions", r));
  const content = {
    jobs: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE is_open = 1").get().n,
    posts: db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'").get().n,
    projects: db.prepare("SELECT COUNT(*) AS n FROM projects WHERE is_visible = 1").get().n,
    vlogs: db.prepare("SELECT COUNT(*) AS n FROM vlogs WHERE status = 'published'").get().n,
  };
  res.json({ ok: true, counts, subscribers, recent, content });
});

/* ---------- Submissions (contact / application / booking) ---------- */

const TYPES = new Set(["contact", "application", "booking"]);

function parseSubmission(row) {
  const r = decryptRow("submissions", row);
  return { ...r, data: JSON.parse(r.data || "{}"), file_path: undefined, has_file: Boolean(r.file_path) };
}

function querySubmissions(type, { status, q }) {
  let sql = "SELECT * FROM submissions WHERE type = ?";
  const params = [type];
  if (status && status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  } else if (!status) {
    sql += " AND status != 'archived'";
  }
  sql += " ORDER BY created_at DESC";
  const rows = db.prepare(sql).all(...params).map(parseSubmission);
  if (!q) return rows.slice(0, 1000);
  // Fields are encrypted, so search happens after decrypting.
  const needle = q.toLowerCase();
  return rows
    .filter((r) => [r.name, r.email, JSON.stringify(r.data)].some((v) => String(v || "").toLowerCase().includes(needle)))
    .slice(0, 1000);
}

adminRouter.param("type", (req, res, next, type) => {
  if (!TYPES.has(type)) return res.status(404).json({ ok: false, error: "Unknown type." });
  next();
});

adminRouter.get("/submissions/:type", (req, res) => {
  res.json({ ok: true, items: querySubmissions(req.params.type, { status: str(req.query.status, 20), q: str(req.query.q, 100) }) });
});

const CSV_COLUMNS = {
  contact: [
    ["First Name", "first_name"],
    ["Last Name", "last_name"],
    ["Mobile", "phone"],
    ["City", "city"],
    ["State", "state"],
    ["Subject", "subject"],
    ["Message", "message"],
  ],
  application: [
    ["Position", "position"],
    ["Message", "message"],
  ],
  booking: [
    ["Date", "date"],
    ["Time", "time"],
    ["Service", "service"],
  ],
};

adminRouter.get("/submissions/:type/export.csv", (req, res) => {
  const { type } = req.params;
  const rows = querySubmissions(type, { status: "all" });
  const columns = [
    { label: "Received", get: (r) => r.created_at },
    { label: "Name", get: (r) => r.name },
    { label: "Email", get: (r) => r.email },
    ...CSV_COLUMNS[type].map(([label, key]) => ({ label, get: (r) => r.data[key] })),
    ...(type === "application" ? [{ label: "Resume", get: (r) => r.file_name }] : []),
    { label: "Status", get: (r) => r.status },
    { label: "Notes", get: (r) => r.notes },
  ];
  res.attachment(`magzest-${type}-${nowIso().slice(0, 10)}.csv`).type("text/csv").send(toCsv(rows, columns));
});

adminRouter.patch("/submissions/:type/:id", (req, res) => {
  const row = db.prepare("SELECT id FROM submissions WHERE id = ? AND type = ?").get(Number(req.params.id), req.params.type);
  if (!row) return res.status(404).json({ ok: false, error: "Not found." });
  const { status, notes } = req.body || {};
  if (status !== undefined) {
    if (!["new", "read", "archived"].includes(status)) return res.status(400).json({ ok: false, error: "Bad status." });
    db.prepare("UPDATE submissions SET status = ? WHERE id = ?").run(status, row.id);
  }
  if (notes !== undefined) db.prepare("UPDATE submissions SET notes = ? WHERE id = ?").run(encrypt(str(notes, 5000)), row.id);
  res.json({ ok: true });
});

adminRouter.delete("/submissions/:type/:id", (req, res) => {
  const row = db.prepare("SELECT id, file_path FROM submissions WHERE id = ? AND type = ?").get(Number(req.params.id), req.params.type);
  if (!row) return res.status(404).json({ ok: false, error: "Not found." });
  if (row.file_path) fs.rm(path.join(config.resumeDir, path.basename(row.file_path)), { force: true }, () => {});
  db.prepare("DELETE FROM submissions WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

adminRouter.get("/submissions/application/:id/resume", (req, res) => {
  const row = decryptRow("submissions", db.prepare("SELECT file_path, file_name FROM submissions WHERE id = ? AND type = 'application'").get(Number(req.params.id)));
  if (!row?.file_path) return res.status(404).send("No resume attached.");
  const file = path.join(config.resumeDir, path.basename(row.file_path));
  if (!fs.existsSync(file)) return res.status(404).send("Resume file is missing.");
  res.attachment(row.file_name || path.basename(file)).send(decryptBuffer(fs.readFileSync(file)));
});

/* ---------- Subscribers ---------- */

adminRouter.get("/subscribers", (req, res) => {
  const items = db.prepare("SELECT id, email, status, source, created_at FROM subscribers ORDER BY created_at DESC").all();
  res.json({ ok: true, items: items.map((r) => decryptRow("subscribers", r)) });
});

adminRouter.get("/subscribers/export.csv", (req, res) => {
  const rows = db
    .prepare("SELECT email, status, source, created_at FROM subscribers WHERE status = 'active' ORDER BY created_at")
    .all()
    .map((r) => decryptRow("subscribers", r));
  const columns = [
    { label: "Email", get: (r) => r.email },
    { label: "Subscribed", get: (r) => r.created_at },
    { label: "Source page", get: (r) => r.source },
  ];
  res.attachment(`magzest-subscribers-${nowIso().slice(0, 10)}.csv`).type("text/csv").send(toCsv(rows, columns));
});

adminRouter.delete("/subscribers/:id", (req, res) => {
  db.prepare("DELETE FROM subscribers WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Content: jobs, posts, projects, vlogs ---------- */

// Each entry: which columns the admin may write, and how to clean them.
const bool = (v) => (v === true || v === 1 || v === "1" || v === "true" ? 1 : 0);
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const isoDate = (v) => {
  if (!str(v, 40)) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest("Publish date isn't a valid date.");
  return d.toISOString();
};

const CONTENT = {
  __proto__: null,
  jobs: {
    order: "sort_order, id",
    fields: {
      title: (v) => str(v, 120),
      location: (v) => str(v, 60),
      employment_type: (v) => str(v, 60),
      stack: (v) => str(v, 120),
      icon: (v) => slugify(v) || "briefcase",
      is_open: bool,
      sort_order: int,
    },
    required: ["title"],
  },
  posts: {
    order: "COALESCE(published_at, created_at) DESC",
    fields: {
      title: (v) => str(v, 200),
      slug: (v) => slugify(v),
      category: (v) => str(v, 60),
      excerpt: (v) => str(v, 400),
      cover_image: (v) => str(v, 300),
      body: (v) => str(v, 200000),
      status: (v) => (["draft", "coming_soon", "published"].includes(v) ? v : "draft"),
      published_at: isoDate,
    },
    required: ["title", "slug"],
  },
  projects: {
    order: "sort_order, id",
    fields: {
      title: (v) => str(v, 120),
      category_label: (v) => str(v, 60),
      category: (v) => slugify(v),
      kind: (v) => str(v, 60),
      description: (v) => str(v, 400),
      tags: (v) => str(v, 300),
      mockup_html: (v) => str(v, 20000),
      image: (v) => str(v, 300),
      is_visible: bool,
      sort_order: int,
    },
    required: ["title", "category_label"],
  },
  vlogs: {
    order: "COALESCE(published_at, created_at) DESC",
    fields: {
      title: (v) => str(v, 200),
      category: (v) => str(v, 60),
      description: (v) => str(v, 1000),
      video_url: (v) => {
        const url = str(v, 500);
        if (url && !videoSource(url)) throw badRequest("Video must be an uploaded video, or a YouTube or Vimeo link.");
        return url;
      },
      thumbnail: (v) => str(v, 300),
      status: (v) => (["draft", "published"].includes(v) ? v : "draft"),
      published_at: isoDate,
    },
    required: ["title", "video_url"],
  },
};

function cleanInput(kind, body, isCreate) {
  const spec = CONTENT[kind];
  const out = {};
  for (const [key, clean] of Object.entries(spec.fields)) {
    if (body[key] !== undefined) out[key] = clean(body[key]);
  }
  // Derive slugs from titles/labels when they weren't given.
  if (kind === "posts" && !out.slug && body.title !== undefined && isCreate) out.slug = slugify(body.title);
  if (kind === "projects" && body.category_label !== undefined && !body.category) out.category = slugify(body.category_label);
  // A blank publish date on a published post/vlog means "keep / fill
  // automatically", not "clear it" — the create/update handlers fill it in.
  if ("published_at" in spec.fields && out.status === "published" && !out.published_at) out.published_at = undefined;
  return out;
}

adminRouter.get("/content/:kind", (req, res) => {
  const spec = CONTENT[req.params.kind];
  if (!spec) return res.status(404).json({ ok: false });
  res.json({ ok: true, items: db.prepare(`SELECT * FROM ${req.params.kind} ORDER BY ${spec.order}`).all() });
});

adminRouter.post("/content/:kind", (req, res) => {
  const { kind } = req.params;
  const spec = CONTENT[kind];
  if (!spec) return res.status(404).json({ ok: false });
  const data = cleanInput(kind, req.body || {}, true);
  for (const key of spec.required) if (!data[key]) return res.status(400).json({ ok: false, error: `${key} is required.` });
  if ("published_at" in spec.fields && data.status === "published" && !data.published_at) data.published_at = nowIso();
  if (kind === "posts" && db.prepare("SELECT 1 FROM posts WHERE slug = ?").get(data.slug)) {
    return res.status(400).json({ ok: false, error: "Another post already uses that URL slug." });
  }
  // New jobs/projects go to the end of the list unless an order was given.
  if ("sort_order" in spec.fields && req.body?.sort_order === undefined) {
    data.sort_order = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ${kind}`).get().n;
  }
  const now = nowIso();
  Object.assign(data, { created_at: now, updated_at: now });
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  const keys = Object.keys(data);
  const result = db
    .prepare(`INSERT INTO ${kind} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...keys.map((k) => data[k]));
  res.json({ ok: true, item: db.prepare(`SELECT * FROM ${kind} WHERE id = ?`).get(result.lastInsertRowid) });
});

adminRouter.put("/content/:kind/:id", (req, res) => {
  const { kind } = req.params;
  const spec = CONTENT[kind];
  if (!spec) return res.status(404).json({ ok: false });
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM ${kind} WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ ok: false, error: "Not found." });

  const data = cleanInput(kind, req.body || {}, false);
  for (const key of spec.required) if (key in data && !data[key]) return res.status(400).json({ ok: false, error: `${key} is required.` });
  if (kind === "posts" && data.slug && db.prepare("SELECT 1 FROM posts WHERE slug = ? AND id != ?").get(data.slug, id)) {
    return res.status(400).json({ ok: false, error: "Another post already uses that URL slug." });
  }
  if ("published_at" in spec.fields && data.status === "published" && !data.published_at && !existing.published_at) data.published_at = nowIso();
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  data.updated_at = nowIso();
  const keys = Object.keys(data);
  db.prepare(`UPDATE ${kind} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => data[k]), id);
  res.json({ ok: true, item: db.prepare(`SELECT * FROM ${kind} WHERE id = ?`).get(id) });
});

adminRouter.delete("/content/:kind/:id", (req, res) => {
  const { kind } = req.params;
  if (!CONTENT[kind]) return res.status(404).json({ ok: false });
  const id = Number(req.params.id);
  const video = kind === "vlogs" ? db.prepare("SELECT video_url FROM vlogs WHERE id = ?").get(id)?.video_url : null;
  db.prepare(`DELETE FROM ${kind} WHERE id = ?`).run(id);
  // An uploaded video belongs to its vlog: remove the file with it.
  if (videoSource(video)?.type === "file" && !db.prepare("SELECT 1 FROM vlogs WHERE video_url = ?").get(video)) {
    fs.rm(path.join(config.videoDir, path.basename(video)), { force: true }, () => {});
  }
  res.json({ ok: true });
});

/* ---------- Image uploads (blog covers, project thumbnails) ---------- */

// SVG is deliberately excluded: it can carry scripts and is served from
// the site's own origin.
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: config.mediaDir,
    filename: (req, file, cb) => {
      const base = slugify(path.parse(file.originalname).name).slice(0, 40) || "image";
      cb(null, `${base}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = IMAGE_EXT.has(path.extname(file.originalname).toLowerCase()) && file.mimetype.startsWith("image/");
    cb(ok ? null : Object.assign(new Error("Upload a JPG, PNG, WEBP, GIF or AVIF image."), { status: 400 }), ok);
  },
});

adminRouter.post("/media", (req, res) => {
  mediaUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "Image must be under 5 MB." : err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded." });
    res.json({ ok: true, url: `uploads/${req.file.filename}` });
  });
});

adminRouter.get("/media", (req, res) => {
  const items = fs
    .readdirSync(config.mediaDir)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => ({ name: f, url: `uploads/${f}`, mtime: fs.statSync(path.join(config.mediaDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  res.json({ ok: true, items });
});

adminRouter.delete("/media/:name", (req, res) => {
  fs.rm(path.join(config.mediaDir, path.basename(req.params.name)), { force: true }, () => res.json({ ok: true }));
});

/* ---------- Video uploads (vlogs) ---------- */

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const MAX_VIDEO_MB = 500;

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: config.videoDir,
    filename: (req, file, cb) => {
      const base = slugify(path.parse(file.originalname).name).slice(0, 40) || "video";
      cb(null, `${base}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = VIDEO_EXT.has(path.extname(file.originalname).toLowerCase()) && file.mimetype.startsWith("video/");
    cb(ok ? null : Object.assign(new Error("Upload an MP4, WEBM or MOV video."), { status: 400 }), ok);
  },
});

// Check the file really is a video: MP4/MOV have an "ftyp" box at byte 4,
// WebM starts with the EBML signature. A renamed file of another kind fails.
function looksLikeVideo(file) {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head.toString("latin1", 4, 8) === "ftyp" || head.readUInt32BE(0) === 0x1a45dfa3;
}

adminRouter.post("/videos", (req, res) => {
  videoUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? `Video must be under ${MAX_VIDEO_MB} MB. For longer videos, upload to YouTube and paste the link.` : err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded." });
    if (!looksLikeVideo(req.file.path)) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ ok: false, error: "That file isn't a playable video. Export it as MP4 and try again." });
    }
    res.json({ ok: true, url: `uploads/videos/${req.file.filename}` });
  });
});
