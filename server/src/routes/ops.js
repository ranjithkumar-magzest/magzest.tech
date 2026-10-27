/* =========================================================
   Magzest server — admin operations API (/api/admin/*)
   Hiring pipeline, leads CRM, booking calendar, analytics
   and backups. Mounted after routes/admin.js, whose
   requireAdmin has already run for every request here.
   ========================================================= */

import path from "node:path";
import fs from "node:fs";
import express from "express";
import { db } from "../db.js";
import { requireAdmin } from "../auth.js";
import { sendAdminEmail } from "../mailer.js";
import { getSettings, saveSettings, isSlotAvailable, buildInvite, bookingUid, istNow, addDays } from "../booking.js";
import { analyticsReport } from "../analytics.js";
import { listBackups, runBackup, backupDir } from "../backup.js";
import { biginStatus, retryFailed } from "../bigin.js";
import { config } from "../config.js";
import { str, nowIso } from "../util.js";
import { encrypt, decrypt, decryptRow } from "../crypto.js";

export const opsRouter = express.Router();
opsRouter.use(express.json({ limit: "200kb" }));
// Defence in depth: never reachable without a session even if mounted elsewhere.
opsRouter.use(requireAdmin);

export const HIRING_STAGES = ["new", "shortlisted", "interview", "offer", "hired", "rejected"];
export const LEAD_STAGES = ["new", "contacted", "proposal", "won", "lost"];
const stagesFor = (type) => (type === "application" ? HIRING_STAGES : LEAD_STAGES);
const label = (stage) => stage.charAt(0).toUpperCase() + stage.slice(1);

function getSubmission(id) {
  const row = decryptRow("submissions", db.prepare("SELECT * FROM submissions WHERE id = ?").get(Number(id)));
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data || "{}") };
}

function logActivity(submissionId, kind, text, admin) {
  db.prepare("INSERT INTO activity (submission_id, kind, text, admin_email, created_at) VALUES (?, ?, ?, ?, ?)").run(
    submissionId,
    kind,
    encrypt(text),
    admin?.email || "",
    nowIso()
  );
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

/* ---------- Pipeline (hiring + leads) ---------- */

opsRouter.get("/pipeline/:board", (req, res, next) => {
  const types = { hiring: ["application"], leads: ["contact", "booking"] }[req.params.board];
  if (!types) return next();
  const includeArchived = req.query.archived === "1";
  const rows = db
    .prepare(
      `SELECT * FROM submissions WHERE type IN (${types.map(() => "?").join(",")})
       ${includeArchived ? "" : "AND status != 'archived'"} ORDER BY created_at DESC LIMIT 2000`
    )
    .all(...types)
    .map((r) => decryptRow("submissions", r))
    .map((r) => ({ ...r, data: JSON.parse(r.data || "{}"), has_file: Boolean(r.file_path), file_path: undefined }));
  res.json({ ok: true, stages: stagesFor(types[0]), items: rows });
});

opsRouter.patch("/pipeline/item/:id", (req, res) => {
  const row = getSubmission(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "Not found." });
  const b = req.body || {};
  const updates = {};
  if (b.stage !== undefined) {
    if (!stagesFor(row.type).includes(b.stage)) return res.status(400).json({ ok: false, error: "Unknown stage." });
    updates.stage = b.stage;
  }
  if (b.rating !== undefined) updates.rating = Math.max(0, Math.min(5, Math.trunc(Number(b.rating)) || 0));
  if (b.deal_value !== undefined) updates.deal_value = Math.max(0, Math.min(1e10, Math.round(Number(b.deal_value)) || 0));
  if (b.follow_up !== undefined) updates.follow_up = /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up) ? b.follow_up : null;
  const keys = Object.keys(updates);
  if (!keys.length) return res.json({ ok: true });
  db.prepare(`UPDATE submissions SET ${keys.map((k) => `${k} = ?`).join(", ")}${row.status === "new" ? ", status = 'read'" : ""} WHERE id = ?`).run(
    ...keys.map((k) => updates[k]),
    row.id
  );
  if (updates.stage && updates.stage !== row.stage) logActivity(row.id, "stage", `${label(row.stage)} → ${label(updates.stage)}`, req.admin);
  if (updates.deal_value !== undefined && updates.deal_value !== row.deal_value) {
    logActivity(row.id, "note", `Deal value set to ₹${updates.deal_value.toLocaleString("en-IN")}`, req.admin);
  }
  res.json({ ok: true, item: getSubmission(row.id) });
});

opsRouter.get("/pipeline/item/:id/activity", (req, res) => {
  res.json({
    ok: true,
    items: db
      .prepare("SELECT id, kind, text, admin_email, created_at FROM activity WHERE submission_id = ? ORDER BY created_at DESC, id DESC")
      .all(Number(req.params.id))
      .map((r) => decryptRow("activity", r)),
  });
});

opsRouter.post("/pipeline/item/:id/notes", (req, res) => {
  const row = getSubmission(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "Not found." });
  const text = str(req.body?.text, 5000);
  if (!text) return res.status(400).json({ ok: false, error: "Write a note first." });
  logActivity(row.id, "note", text, req.admin);
  res.json({ ok: true });
});

opsRouter.post("/pipeline/item/:id/email", async (req, res) => {
  const row = getSubmission(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: "Not found." });
  const subject = str(req.body?.subject, 200);
  const text = str(req.body?.text, 20000);
  if (!subject || !text) return res.status(400).json({ ok: false, error: "Subject and message are required." });
  const result = await sendAdminEmail({ to: row.email, subject, text });
  if (!result.sent) return res.status(502).json({ ok: false, error: `Email not sent: ${result.error}` });
  logActivity(row.id, "email", `Emailed: “${subject}”`, req.admin);
  res.json({ ok: true });
});

/* ---------- CRM summary (dashboard) ---------- */

function crmSummary() {
  const today = istNow().date;
  const monthStart = today.slice(0, 8) + "01";
  const leadTypes = "type IN ('contact', 'booking') AND status != 'archived'";
  const stages = Object.fromEntries(LEAD_STAGES.map((s) => [s, { count: 0, value: 0 }]));
  for (const r of db.prepare(`SELECT stage, COUNT(*) AS count, SUM(deal_value) AS value FROM submissions WHERE ${leadTypes} GROUP BY stage`).all()) {
    if (stages[r.stage]) stages[r.stage] = { count: r.count, value: r.value || 0 };
  }
  const hiring = Object.fromEntries(HIRING_STAGES.map((s) => [s, 0]));
  for (const r of db.prepare("SELECT stage, COUNT(*) AS n FROM submissions WHERE type = 'application' AND status != 'archived' GROUP BY stage").all()) {
    if (r.stage in hiring) hiring[r.stage] = r.n;
  }
  const followUps = db
    .prepare(
      `SELECT id, type, name, email, stage, follow_up, deal_value FROM submissions
       WHERE follow_up IS NOT NULL AND follow_up <= ? AND stage NOT IN ('won', 'lost', 'hired', 'rejected') AND status != 'archived'
       ORDER BY follow_up LIMIT 20`
    )
    .all(today)
    .map((r) => decryptRow("submissions", r));
  const upcoming = db
    .prepare(
      `SELECT id, name, email, slot, booking_status, data FROM submissions
       WHERE type = 'booking' AND slot >= ? AND booking_status != 'cancelled' ORDER BY slot LIMIT 10`
    )
    .all(today)
    .map((r) => decryptRow("submissions", r))
    .map(({ data, ...r }) => ({ ...r, service: JSON.parse(data || "{}").service ?? null }));
  // Activity text is encrypted, so "moved to Won this month" is checked here.
  const wonRows = db
    .prepare(
      `SELECT s.id, s.deal_value, a.text FROM submissions s JOIN activity a ON a.submission_id = s.id
       WHERE s.stage = 'won' AND a.kind = 'stage' AND a.created_at >= ?`
    )
    .all(monthStart + "T00:00:00");
  const wonIds = new Map(wonRows.filter((r) => decrypt(r.text).endsWith("→ Won")).map((r) => [r.id, r.deal_value || 0]));
  const wonThisMonth = [...wonIds.values()].reduce((a, b) => a + b, 0);
  return { today, stages, hiring, followUps, upcoming, wonThisMonth };
}


/* ---------- Dashboard: what needs doing today ---------- */

// Everything the admin home page shows, in one response. "attention" is a
// to-do list worked out from the data: unread leads, calls waiting to be
// confirmed, follow-ups due, and anything wrong with email, backups or Bigin.
opsRouter.get("/dashboard", (req, res) => {
  const crm = crmSummary();
  const { today } = crm;
  const istDay = "substr(datetime(created_at, '+330 minutes'), 1, 10)";
  const attention = [];
  const add = (tone, kind, title, detail, href, extra) => attention.push({ tone, kind, title, detail, href, ...extra });
  const shortDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

  // Unread messages, newest first: a few by name, the rest rolled up.
  // (New bookings are listed below as calls to confirm.)
  const unread = db
    .prepare("SELECT id, type, name, data, created_at FROM submissions WHERE status = 'new' AND type = 'contact' ORDER BY created_at DESC")
    .all()
    .map((r) => decryptRow("submissions", r));
  for (const r of unread.slice(0, 4)) {
    const d = JSON.parse(r.data || "{}");
    const what = d.message ? `“${d.message.slice(0, 90)}${d.message.length > 90 ? "…" : ""}”` : "Sent a message";
    add("blue", "lead", `New enquiry from ${r.name || "a visitor"}`, what, `#/leads/${r.id}`, { at: r.created_at });
  }
  if (unread.length > 4) add("blue", "lead", `${unread.length - 4} more unread enquiries`, "Waiting in the leads board", "#/leads");

  const newApplications = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'new' AND type = 'application'").get().n;
  if (newApplications) add("blue", "hiring", `${newApplications} new job application${newApplications === 1 ? "" : "s"}`, "Not opened yet", "#/hiring");

  // Calls the visitor booked that nobody has confirmed. Within a day is urgent.
  const now = istNow();
  const soon = `${addDays(today, 1)} ${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}`;
  const pending = db
    .prepare("SELECT id, name, slot FROM submissions WHERE type = 'booking' AND booking_status = 'pending' AND slot >= ? ORDER BY slot LIMIT 10")
    .all(today)
    .map((r) => decryptRow("submissions", r));
  for (const b of pending) {
    add(b.slot <= soon ? "red" : "amber", "booking", `Confirm the call with ${b.name}`, formatSlot(b.slot), "#/calendar", { slot: b.slot });
  }

  for (const f of crm.followUps.slice(0, 5)) {
    const overdue = f.follow_up < today;
    add(overdue ? "red" : "amber", "follow-up", `Follow up with ${f.name}`, overdue ? `Was due ${shortDate(f.follow_up)}` : "Due today", `#/${f.type === "application" ? "hiring" : "leads"}/${f.id}`);
  }

  // System health.
  const email = Boolean(config.mail.host && config.mail.user && config.mail.pass);
  if (!email) add("red", "system", "Email isn't set up", "Form alerts, auto-replies and sign-in codes can't be sent. Add the SMTP settings to server/.env.", "#/settings");
  const backup = listBackups()[0] || null;
  const backupAgeHours = backup ? (Date.now() - Date.parse(backup.created_at)) / 3600000 : null;
  if (backupAgeHours === null || backupAgeHours > 48) {
    add("amber", "system", backup ? "Backups have stopped" : "No database backup yet", backup ? `The newest one is ${Math.floor(backupAgeHours / 24)} days old.` : "Run one now from Settings.", "#/settings");
  }
  const bigin = biginStatus();
  if (bigin.enabled && bigin.failed) add("amber", "system", `${bigin.failed} lead${bigin.failed === 1 ? "" : "s"} didn't reach Bigin`, "Retry them from Settings.", "#/settings");

  const rank = { red: 0, amber: 1, blue: 2 };
  attention.sort((a, b) => rank[a.tone] - rank[b.tone]);

  // This week against the week before.
  const report = analyticsReport(7);
  const from = report.from;
  const prevFrom = addDays(from, -7);
  const prevTo = addDays(from, -1);
  const countTypes = (types, a, b) =>
    db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE type IN (${types.map(() => "?").join(",")}) AND ${istDay} BETWEEN ? AND ?`).get(...types, a, b).n;
  const week = {
    daily: report.daily,
    visitors: { current: report.current.visitors, previous: report.previous.visitors },
    views: { current: report.current.views, previous: report.previous.views },
    enquiries: { current: countTypes(["contact", "booking"], from, today), previous: countTypes(["contact", "booking"], prevFrom, prevTo) },
    applications: { current: countTypes(["application"], from, today), previous: countTypes(["application"], prevFrom, prevTo) },
    subscribers: { current: report.current.subscribers, previous: report.previous.subscribers },
  };

  const recent = db
    .prepare("SELECT id, type, name, status, created_at FROM submissions ORDER BY created_at DESC LIMIT 6")
    .all()
    .map((r) => decryptRow("submissions", r));
  const live = {
    jobs: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE is_open = 1").get().n,
    posts: db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'").get().n,
    vlogs: db.prepare("SELECT COUNT(*) AS n FROM vlogs WHERE status = 'published'").get().n,
    projects: db.prepare("SELECT COUNT(*) AS n FROM projects WHERE is_visible = 1").get().n,
    subscribers: db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'").get().n,
  };

  res.json({
    ok: true,
    me: req.admin.email,
    today,
    attention,
    week,
    stages: crm.stages,
    wonThisMonth: crm.wonThisMonth,
    hiring: crm.hiring,
    upcoming: crm.upcoming,
    recent,
    live,
    health: { email, backup: backup && { created_at: backup.created_at }, bigin: { enabled: bigin.enabled, failed: bigin.failed, pending: bigin.pending } },
  });
});

/* ---------- Bookings ---------- */

const DAY_FMT = { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" };
function formatSlot(slot) {
  const [date, time] = slot.split(" ");
  const day = new Date(date + "T00:00:00Z").toLocaleDateString("en-IN", DAY_FMT);
  const [h, m] = time.split(":").map(Number);
  return `${day} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} IST`;
}

function getBooking(req, res) {
  const row = getSubmission(req.params.id);
  if (!row || row.type !== "booking") {
    res.status(404).json({ ok: false, error: "Booking not found." });
    return null;
  }
  return row;
}

function invite(row, method) {
  const [date, time] = (row.slot || `${row.data.date} ${row.data.time}`).split(" ");
  return buildInvite({
    uid: bookingUid(row.id),
    date,
    time,
    minutes: row.data.duration || getSettings().slotMinutes,
    summary: `Magzest consultation — ${row.data.service || "call"}`,
    description: `Consultation call between ${row.name} and Magzest.${row.meeting_link ? `\nJoin: ${row.meeting_link}` : ""}`,
    url: row.meeting_link,
    organizer: config.mail.notifyTo,
    attendee: { name: row.name, email: row.email },
    method,
    sequence: row.data.invite_sequence || 0,
  });
}

function setBookingData(row, patch) {
  const data = { ...row.data, ...patch };
  db.prepare("UPDATE submissions SET data = ? WHERE id = ?").run(encrypt(JSON.stringify(data)), row.id);
  row.data = data;
}

opsRouter.get("/booking/settings", (req, res) => res.json({ ok: true, settings: getSettings() }));

opsRouter.put("/booking/settings", (req, res) => res.json({ ok: true, settings: saveSettings(req.body || {}) }));

opsRouter.get("/booking/upcoming", (req, res) => {
  const items = db
    .prepare(
      `SELECT * FROM submissions WHERE type = 'booking' AND booking_status != 'cancelled' AND slot >= ? ORDER BY slot LIMIT 200`
    )
    .all(addDays(istNow().date, -1))
    .map((r) => decryptRow("submissions", r))
    .map((r) => ({ ...r, data: JSON.parse(r.data || "{}"), file_path: undefined }));
  res.json({ ok: true, items });
});

opsRouter.post("/booking/:id/confirm", async (req, res) => {
  const row = getBooking(req, res);
  if (!row) return;
  if (row.booking_status === "cancelled") return res.status(400).json({ ok: false, error: "This booking was cancelled. Ask the client to book again." });
  const link = str(req.body?.meeting_link, 500) || getSettings().meetingLink;
  if (link && !/^https:\/\/\S+$/.test(link)) return res.status(400).json({ ok: false, error: "Meeting link must start with https://" });
  db.prepare("UPDATE submissions SET booking_status = 'confirmed', meeting_link = ?, status = CASE WHEN status = 'new' THEN 'read' ELSE status END WHERE id = ?").run(encrypt(link), row.id);
  row.meeting_link = link;
  setBookingData(row, { duration: row.data.duration || getSettings().slotMinutes });

  const note = str(req.body?.message, 3000);
  const text = [
    `Hi ${firstName(row.name)},`,
    `Your consultation with Magzest is confirmed for ${formatSlot(row.slot)} (${row.data.duration} minutes).`,
    link ? `Join the call here: ${link}` : "We'll call you at the scheduled time.",
    note,
    "A calendar invite is attached. If you need to change the time, just reply to this email.",
    "— Team Magzest",
  ]
    .filter(Boolean)
    .join("\n\n");
  const ics = invite(row, "REQUEST");
  const mail = await sendAdminEmail({
    to: row.email,
    subject: "Your call with Magzest is confirmed",
    text,
    icalEvent: { method: "REQUEST", filename: "magzest-call.ics", content: ics },
  });
  logActivity(row.id, "booking", `Confirmed for ${formatSlot(row.slot)}${mail.sent ? " — invite emailed" : ` — email not sent (${mail.error})`}`, req.admin);
  res.json({ ok: true, emailed: mail.sent, emailError: mail.error });
});

opsRouter.post("/booking/:id/reschedule", async (req, res) => {
  const row = getBooking(req, res);
  if (!row) return;
  const date = str(req.body?.date, 10);
  const time = str(req.body?.time, 5);
  if (!isSlotAvailable(date, time)) return res.status(400).json({ ok: false, error: "That slot isn't available. Pick another." });
  const newSlot = `${date} ${time}`;
  try {
    db.prepare("UPDATE submissions SET slot = ?, booking_status = CASE WHEN booking_status = 'cancelled' THEN 'pending' ELSE booking_status END WHERE id = ?").run(newSlot, row.id);
  } catch {
    return res.status(409).json({ ok: false, error: "That slot was just taken. Pick another." });
  }
  const oldSlot = row.slot;
  row.slot = newSlot;
  setBookingData(row, { date, time, invite_sequence: (row.data.invite_sequence || 0) + 1 });
  const current = getSubmission(row.id);

  let mail = { sent: false, error: "not confirmed yet, so no email was sent" };
  if (current.booking_status === "confirmed") {
    const note = str(req.body?.message, 3000);
    mail = await sendAdminEmail({
      to: row.email,
      subject: "Your call with Magzest has moved",
      text: [`Hi ${firstName(row.name)},`, `Your consultation has been moved to ${formatSlot(newSlot)}.`, current.meeting_link ? `Join the call here: ${current.meeting_link}` : "", note, "The updated calendar invite is attached.", "— Team Magzest"]
        .filter(Boolean)
        .join("\n\n"),
      icalEvent: { method: "REQUEST", filename: "magzest-call.ics", content: invite(current, "REQUEST") },
    });
  }
  logActivity(row.id, "booking", `Moved from ${oldSlot ? formatSlot(oldSlot) : "—"} to ${formatSlot(newSlot)}${mail.sent ? " — update emailed" : ""}`, req.admin);
  res.json({ ok: true, emailed: mail.sent, emailError: mail.error });
});

opsRouter.post("/booking/:id/cancel", async (req, res) => {
  const row = getBooking(req, res);
  if (!row) return;
  if (row.booking_status === "cancelled") return res.json({ ok: true });
  const wasConfirmed = row.booking_status === "confirmed";
  const slot = row.slot;
  setBookingData(row, { invite_sequence: (row.data.invite_sequence || 0) + 1 });
  const ics = slot ? invite(row, "CANCEL") : null;
  db.prepare("UPDATE submissions SET booking_status = 'cancelled', slot = NULL WHERE id = ?").run(row.id);

  let mail = { sent: false };
  if (req.body?.notify !== false && slot) {
    const note = str(req.body?.message, 3000);
    mail = await sendAdminEmail({
      to: row.email,
      subject: "Your call with Magzest has been cancelled",
      text: [`Hi ${firstName(row.name)},`, `Your consultation on ${formatSlot(slot)} has been cancelled.`, note, "You're welcome to book a new time on our website whenever suits you.", "— Team Magzest"]
        .filter(Boolean)
        .join("\n\n"),
      icalEvent: wasConfirmed ? { method: "CANCEL", filename: "magzest-call.ics", content: ics } : undefined,
    });
  }
  logActivity(row.id, "booking", `Cancelled${slot ? ` (${formatSlot(slot)})` : ""}${mail.sent ? " — client emailed" : ""}`, req.admin);
  res.json({ ok: true, emailed: mail.sent, emailError: mail.error });
});

opsRouter.get("/booking/:id/invite.ics", (req, res) => {
  const row = getBooking(req, res);
  if (!row) return;
  if (!row.slot) return res.status(400).send("This booking has no time slot.");
  res.attachment(`magzest-call-${row.id}.ics`).type("text/calendar").send(invite(row, "PUBLISH"));
});

/* ---------- Analytics ---------- */

opsRouter.get("/analytics", (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  res.json({ ok: true, ...analyticsReport(days) });
});

/* ---------- Bigin sync ---------- */

opsRouter.get("/bigin/status", (req, res) => res.json({ ok: true, ...biginStatus() }));

opsRouter.post("/bigin/retry", (req, res) => res.json({ ok: true, retried: retryFailed() }));

/* ---------- Backups ---------- */

opsRouter.get("/backups", (req, res) => res.json({ ok: true, items: listBackups() }));

opsRouter.post("/backups", (req, res) => res.json({ ok: true, item: runBackup() }));

opsRouter.get("/backups/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(backupDir, name);
  if (!/^magzest-[\d-]+\.db$/.test(name) || !fs.existsSync(file)) return res.status(404).send("Backup not found.");
  res.download(file, name);
});
