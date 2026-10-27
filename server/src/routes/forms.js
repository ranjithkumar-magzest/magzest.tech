/* =========================================================
   Magzest server — public form endpoints
   POST /api/forms/contact      contact page
   POST /api/forms/application  careers page (multipart, resume)
   POST /api/forms/booking      "Book a call" modal
   POST /api/forms/newsletter   footer + blog newsletter
   GET|POST /api/newsletter/confirm?token=…
   GET|POST /api/newsletter/unsubscribe?token=…

   All forms send multipart FormData (that's what the site's
   JS already does), so multer parses every one of them.
   ========================================================= */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { db } from "../db.js";
import { notifyTeam, notifyTeamSubscriber, autoReply, sendSubscribeConfirmation } from "../mailer.js";
import { EMAIL_RE, str, nowIso, escapeHtml } from "../util.js";
import { isSlotAvailable, istNow } from "../booking.js";
import { queueForBigin } from "../bigin.js";
import { encrypt, decrypt, emailIndex, encryptBuffer } from "../crypto.js";

export const formsRouter = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { ok: false, error: "Too many submissions. Please try again in a few minutes." },
});

const RESUME_EXT = new Set([".pdf", ".doc", ".docx"]);
const MAX_RESUME_MB = 5;

const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: config.resumeDir,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_RESUME_MB * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => {
    const ok = RESUME_EXT.has(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : Object.assign(new Error("Resume must be a PDF, DOC or DOCX file."), { status: 400 }), ok);
  },
});
const fieldsOnly = multer({ limits: { fields: 20, files: 0 } }).none();

// A filled-in honeypot means a bot. Pretend it worked so it doesn't retry.
function isBot(req) {
  return Boolean(req.body && req.body._honey);
}

function fail(res, errors) {
  return res.status(400).json({ ok: false, errors });
}

function saveSubmission(type, req, { name, email, data, file }) {
  const result = db
    .prepare(
      `INSERT INTO submissions (type, name, email, data, file_path, file_name, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      type,
      encrypt(name),
      encrypt(email),
      encrypt(JSON.stringify(data)),
      file ? file.filename : null,
      file ? encrypt(file.originalname) : null,
      encrypt(req.ip || ""),
      nowIso()
    );
  return Number(result.lastInsertRowid);
}

formsRouter.post("/forms/contact", limiter, fieldsOnly, (req, res) => {
  if (isBot(req)) return res.json({ ok: true });
  const b = req.body || {};
  // Field lengths match the Bigin "Contact us" web form.
  const first_name = str(b.first_name, 40);
  const last_name = str(b.last_name, 80);
  const name = `${first_name} ${last_name}`.trim();
  const email = str(b.email, 100);
  const phone = str(b.phone, 30);
  const city = str(b.city, 100);
  const state = str(b.state, 100);
  const message = str(b.message, 5000);
  // The consultation modal posts here too and tags itself.
  const source = b.source === "Consultation request" ? b.source : "";

  // Only Last Name is required (it's the one mandatory field in Bigin).
  const errors = {};
  if (!last_name) errors.last_name = "Please enter your last name.";
  if (email && !EMAIL_RE.test(email)) errors.email = "Please enter a valid email address.";
  if (Object.keys(errors).length) return fail(res, errors);

  const data = { first_name, last_name, phone, city, state, message, ...(source && { source }) };
  queueForBigin("submission", saveSubmission("contact", req, { name, email, data }));
  const fields = { Mobile: phone, City: city, State: state, Message: message };
  notifyTeam("contact", { name, email, fields });
  if (email) autoReply("contact", { name, email, fields });
  res.json({ ok: true });
});

formsRouter.post(
  "/forms/application",
  limiter,
  (req, res, next) =>
    resumeUpload.single("resume")(req, res, (err) => {
      if (!err) return next();
      const message = err.code === "LIMIT_FILE_SIZE" ? `Resume must be under ${MAX_RESUME_MB} MB.` : err.message;
      fail(res, { resume: message });
    }),
  (req, res) => {
    const file = req.file;
    const discardFile = () => file && fs.rm(file.path, { force: true }, () => {});
    if (isBot(req)) {
      discardFile();
      return res.json({ ok: true });
    }
    const b = req.body || {};
    const name = str(b.name, 120);
    const email = str(b.email, 200);
    const position = str(b.position, 120);
    const message = str(b.message, 5000);

    const errors = {};
    if (!name) errors.name = "Please enter your full name.";
    if (!EMAIL_RE.test(email)) errors.email = "Please enter a valid email address.";
    if (!position) errors.position = "Please select a position.";
    if (Object.keys(errors).length) {
      discardFile();
      return fail(res, errors);
    }

    // Encrypt the resume on disk straight away; the email gets the original.
    const resume = file ? fs.readFileSync(file.path) : null;
    if (file) fs.writeFileSync(file.path, encryptBuffer(resume));

    queueForBigin("submission", saveSubmission("application", req, { name, email, data: { position, message }, file }));
    const fields = { Position: position, Message: message, Resume: file ? file.originalname : "Not attached" };
    notifyTeam("application", {
      name,
      email,
      fields,
      attachment: file ? { filename: file.originalname, content: resume } : null,
    });
    const isOpenJob = db.prepare("SELECT 1 FROM jobs WHERE is_open = 1 AND title = ?").get(position);
    autoReply("application", { name, email, fields, knownPosition: isOpenJob ? position : "" });
    res.json({ ok: true });
  }
);

formsRouter.post("/forms/booking", limiter, fieldsOnly, (req, res) => {
  if (isBot(req)) return res.json({ ok: true });
  const b = req.body || {};
  const name = str(b.fullName, 120);
  const email = str(b.email, 200);
  const date = str(b.date, 10);
  const time = str(b.time, 5);
  const service = str(b.service, 120);

  const errors = {};
  if (!name) errors.fullName = "This field is required.";
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = "Please choose a date.";
  else if (!/^\d{2}:\d{2}$/.test(time)) errors.time = "Please pick a time.";
  else if (!isSlotAvailable(date, time)) errors.time = "Sorry, that time isn't available any more. Please pick another.";
  if (!service) errors.service = "This field is required.";
  if (Object.keys(errors).length) return fail(res, errors);

  const id = saveSubmission("booking", req, { name, email, data: { date, time, service, requested_on: istNow().date } });
  // The unique index on slot stops two visitors holding the same time.
  try {
    db.prepare("UPDATE submissions SET slot = ?, booking_status = 'pending' WHERE id = ?").run(`${date} ${time}`, id);
  } catch {
    db.prepare("DELETE FROM submissions WHERE id = ?").run(id);
    return fail(res, { time: "Sorry, that time was just taken. Please pick another." });
  }
  queueForBigin("submission", id);
  const fields = { Date: date, Time: time, Service: service };
  notifyTeam("booking", { name, email, fields });
  autoReply("booking", { name, email, fields });
  res.json({ ok: true });
});

// Sign-ups that were never confirmed are dropped after a week.
const PENDING_DAYS = 7;

// Double opt-in: a sign-up only sends a confirmation email. The address
// isn't subscribed, sent to Bigin or reported to the team until its owner
// clicks the link. The reply is the same whatever the address's state, so
// it doesn't reveal who is subscribed.
formsRouter.post("/forms/newsletter", limiter, fieldsOnly, (req, res) => {
  if (isBot(req)) return res.json({ ok: true, confirm: true });
  const email = str((req.body || {}).email, 200);
  if (!EMAIL_RE.test(email)) return fail(res, { email: "Enter a valid email address." });

  db.prepare("DELETE FROM subscribers WHERE status = 'pending' AND created_at < ?").run(new Date(Date.now() - PENDING_DAYS * 86400000).toISOString());
  const existing = db.prepare("SELECT id, status, token FROM subscribers WHERE email_hash = ?").get(emailIndex(email));
  if (existing?.status === "active") return res.json({ ok: true, confirm: true });
  let token = existing?.token;
  if (!existing) {
    token = crypto.randomBytes(18).toString("base64url");
    const source = str(req.get("Referer") || "", 200).replace(/^https?:\/\/[^/]+/, "");
    db.prepare("INSERT INTO subscribers (email, email_hash, status, token, source, created_at) VALUES (?, ?, 'pending', ?, ?, ?)").run(
      encrypt(email),
      emailIndex(email),
      token,
      source,
      nowIso()
    );
  }
  sendSubscribeConfirmation({ email, confirmUrl: `${config.siteUrl}/api/newsletter/confirm?token=${token}` });
  res.json({ ok: true, confirm: true });
});

// Links in emails are often opened by mail scanners, not people, so
// opening a link only shows a button; the change happens on POST.
function newsletterPage(res, bodyHtml) {
  res
    .type("html")
    .send(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Newsletter | Magzest</title><meta name="robots" content="noindex"><body style="font-family:Inter,Arial,sans-serif;display:grid;place-items:center;min-height:90vh;color:#0f172a"><div style="max-width:420px;text-align:center;padding:16px"><h1 style="font-size:22px">Newsletter</h1>${bodyHtml}<p><a href="/" style="color:#000033">Back to magzest.tech</a></p></div></body>`
    );
}

const confirmButton = (action, token, label) =>
  `<form method="post" action="/api/newsletter/${action}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button style="background:#000033;color:#fff;border:0;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer">${label}</button></form>`;

const findByToken = (token) => (token ? db.prepare("SELECT id, email, status FROM subscribers WHERE token = ?").get(token) : null);
const INVALID_LINK = "<p>This link is invalid or has expired.</p>";
const tokenParser = express.urlencoded({ extended: false, limit: "2kb" });

formsRouter.get("/newsletter/confirm", (req, res) => {
  const token = str(req.query.token, 100);
  const row = findByToken(token);
  if (!row) return newsletterPage(res, INVALID_LINK);
  if (row.status === "active") return newsletterPage(res, `<p>${escapeHtml(decrypt(row.email))} is already subscribed.</p>`);
  newsletterPage(res, `<p>Subscribe ${escapeHtml(decrypt(row.email))} to Magzest's tech &amp; growth articles?</p>${confirmButton("confirm", token, "Confirm subscription")}`);
});

formsRouter.post("/newsletter/confirm", tokenParser, (req, res) => {
  const row = findByToken(str(req.body?.token, 100));
  if (!row) return newsletterPage(res, INVALID_LINK);
  if (row.status !== "active") {
    db.prepare("UPDATE subscribers SET status = 'active' WHERE id = ?").run(row.id);
    queueForBigin("subscriber", row.id);
    notifyTeamSubscriber(decrypt(row.email));
  }
  newsletterPage(res, `<p>Thanks! ${escapeHtml(decrypt(row.email))} is now subscribed.</p>`);
});

formsRouter.get("/newsletter/unsubscribe", (req, res) => {
  const token = str(req.query.token, 100);
  const row = findByToken(token);
  if (!row) return newsletterPage(res, INVALID_LINK);
  if (row.status !== "active") return newsletterPage(res, `<p>${escapeHtml(decrypt(row.email))} isn't subscribed.</p>`);
  newsletterPage(res, `<p>Stop sending newsletter emails to ${escapeHtml(decrypt(row.email))}?</p>${confirmButton("unsubscribe", token, "Unsubscribe")}`);
});

formsRouter.post("/newsletter/unsubscribe", tokenParser, (req, res) => {
  const row = findByToken(str(req.body?.token, 100));
  if (!row) return newsletterPage(res, INVALID_LINK);
  db.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?").run(row.id);
  newsletterPage(res, `<p>${escapeHtml(decrypt(row.email))} has been unsubscribed. You won't receive any more emails from us.</p>`);
});
