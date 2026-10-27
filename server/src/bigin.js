/* =========================================================
   Magzest server — forward leads to Bigin (Zoho CRM)
   Uses the Bigin "Contact us" web form (bigin.zoho.in), so no
   API credentials are needed: each website submission becomes
   a Bigin Contact, with the details in its Description.

   Off unless BIGIN_FORM_XNQSJSDP and BIGIN_FORM_XMIWTLD are set
   (the hidden keys from the web form's source code), so local
   testing never writes into the real CRM.

   Sends go through a small queue table: a lead is saved first,
   then forwarded in the background and retried with backoff if
   Bigin is unreachable — nothing is lost.
   ========================================================= */

import { adminPath } from "./util.js";
import { db } from "./db.js";
import { config } from "./config.js";
import { nowIso } from "./util.js";
import { decryptRow } from "./crypto.js";

const env = process.env;
export const bigin = {
  url: env.BIGIN_FORM_URL || "https://bigin.zoho.in/crm/WebForm",
  xnQsjsdp: env.BIGIN_FORM_XNQSJSDP || "",
  xmIwtLD: env.BIGIN_FORM_XMIWTLD || "",
  actionType: env.BIGIN_FORM_ACTION_TYPE || "Q29udGFjdHM=", // base64 "Contacts"
};
export const biginEnabled = Boolean(bigin.xnQsjsdp && bigin.xmIwtLD);

const MAX_ATTEMPTS = 8;

db.exec(`
  CREATE TABLE IF NOT EXISTS bigin_queue (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('submission', 'subscriber')),
    ref_id      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT NOT NULL,
    last_error  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    sent_at     TEXT,
    UNIQUE (kind, ref_id)
  );
`);

/* ---------- Mapping website data → Bigin Contact fields ---------- */

const SOURCE = {
  contact: "Website — Contact form",
  application: "Website — Job application",
  booking: "Website — Consultation booking",
};

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: "", last: parts[0] || "Website visitor" };
  return { first: parts.slice(0, -1).join(" ").slice(0, 40), last: parts.at(-1).slice(0, 80) };
}

function describe(row) {
  const d = JSON.parse(row.data || "{}");
  const lines = [`Source: ${d.source ? `Website — ${d.source}` : SOURCE[row.type]}`, `Received: ${row.created_at}`];
  if (row.type === "contact") {
    if (d.subject) lines.push(`Subject: ${d.subject}`);
    lines.push("", d.message || "");
  } else if (row.type === "booking") {
    lines.push(`Requested call: ${d.date} at ${d.time} IST`, `Service: ${d.service || "—"}`);
  } else if (row.type === "application") {
    lines.push(`Position: ${d.position || "—"}`);
    if (row.file_name) lines.push(`Resume: ${row.file_name} (download in the Magzest admin → Applications)`);
    if (d.message) lines.push("", d.message);
  }
  lines.push("", `Magzest admin: ${config.siteUrl}${adminPath()}/`);
  return {
    fields: { Mobile: d.phone || "", "Mailing City": d.city || "", "Mailing State": d.state || "" },
    description: lines.join("\n"),
  };
}

function payloadFor(kind, refId) {
  if (kind === "subscriber") {
    const s = decryptRow("subscribers", db.prepare("SELECT email, source, created_at FROM subscribers WHERE id = ?").get(refId));
    if (!s) return null;
    return {
      "Last Name": "Newsletter subscriber",
      Email: s.email,
      Description: `Source: Website — Newsletter sign-up\nSigned up: ${s.created_at}${s.source ? `\nPage: ${s.source}` : ""}`,
    };
  }
  const row = decryptRow("submissions", db.prepare("SELECT * FROM submissions WHERE id = ?").get(refId));
  if (!row) return null;
  const { fields, description } = describe(row);
  // Contact form sends first/last separately; other forms only have a full name.
  const d = JSON.parse(row.data || "{}");
  const { first, last } = d.last_name ? { first: d.first_name || "", last: d.last_name } : splitName(row.name);
  return { "First Name": first, "Last Name": last, Email: row.email, ...fields, Description: description.slice(0, 32000) };
}

/* ---------- Sending ---------- */

async function post(fields) {
  const form = new FormData();
  form.append("xnQsjsdp", bigin.xnQsjsdp);
  form.append("zc_gad", "");
  form.append("xmIwtLD", bigin.xmIwtLD);
  form.append("actionType", bigin.actionType);
  form.append("rmsg", "true");
  form.append("returnURL", "null");
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, String(v));
  const res = await fetch(bigin.url, { method: "POST", body: form, redirect: "follow", signal: AbortSignal.timeout(20000) });
  const body = (await res.text()).slice(0, 4000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // The web form answers 200 with an HTML page either way; error pages mention the problem.
  const text = body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ");
  if (/invalid|not\s+valid|error occurred|exceeded|captcha|unauthori[sz]ed/i.test(text)) {
    throw new Error("Bigin rejected the submission: " + body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200));
  }
}

// After the 1st, 2nd, 3rd … failure, wait 1, 5, 15, 30, 60 … minutes.
const backoffMinutes = (failures) => [1, 5, 15, 30, 60, 180, 360, 720][Math.min(failures - 1, 7)];

let running = false;
export async function processBiginQueue() {
  if (!biginEnabled || running) return;
  running = true;
  try {
    const due = db
      .prepare("SELECT * FROM bigin_queue WHERE status = 'pending' AND next_try_at <= ? ORDER BY id LIMIT 20")
      .all(nowIso());
    for (const job of due) {
      const fields = payloadFor(job.kind, job.ref_id);
      if (!fields) {
        db.prepare("UPDATE bigin_queue SET status = 'failed', last_error = 'Record was deleted before it was sent' WHERE id = ?").run(job.id);
        continue;
      }
      try {
        await post(fields);
        db.prepare("UPDATE bigin_queue SET status = 'sent', attempts = attempts + 1, last_error = '', sent_at = ? WHERE id = ?").run(nowIso(), job.id);
      } catch (err) {
        const attempts = job.attempts + 1;
        const next = new Date(Date.now() + backoffMinutes(attempts) * 60000).toISOString();
        db.prepare("UPDATE bigin_queue SET status = ?, attempts = ?, next_try_at = ?, last_error = ? WHERE id = ?").run(
          attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          next,
          String(err.message).slice(0, 500),
          job.id
        );
        console.error(`[bigin] ${job.kind} #${job.ref_id} attempt ${attempts} failed: ${err.message}`);
      }
    }
  } finally {
    running = false;
  }
}

// Call right after a lead is saved. Never throws — the lead is already safe in the DB.
export function queueForBigin(kind, refId) {
  if (!biginEnabled) return;
  try {
    db.prepare("INSERT OR IGNORE INTO bigin_queue (kind, ref_id, next_try_at, created_at) VALUES (?, ?, ?, ?)").run(kind, refId, nowIso(), nowIso());
    setImmediate(() => processBiginQueue().catch((e) => console.error("[bigin]", e.message)));
  } catch (err) {
    console.error("[bigin] queue:", err.message);
  }
}

export function startBiginWorker() {
  if (!biginEnabled) return console.log("Bigin sync is off (set BIGIN_FORM_XNQSJSDP and BIGIN_FORM_XMIWTLD to turn it on).");
  console.log("Bigin sync is on (web form → Contacts).");
  processBiginQueue().catch(() => {});
  setInterval(() => processBiginQueue().catch(() => {}), 60 * 1000).unref();
}

/* ---------- Admin ---------- */

export function biginStatus() {
  const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM bigin_queue GROUP BY status").all().map((r) => [r.status, r.n]));
  const failures = db
    .prepare("SELECT kind, ref_id, attempts, last_error, created_at FROM bigin_queue WHERE status = 'failed' OR (status = 'pending' AND attempts > 0) ORDER BY id DESC LIMIT 10")
    .all();
  return { enabled: biginEnabled, sent: counts.sent || 0, pending: counts.pending || 0, failed: counts.failed || 0, failures };
}

export function retryFailed() {
  const r = db.prepare("UPDATE bigin_queue SET status = 'pending', attempts = 0, next_try_at = ? WHERE status = 'failed'").run(nowIso());
  setImmediate(() => processBiginQueue().catch(() => {}));
  return r.changes;
}

export function syncStateFor(kind, ids) {
  if (!ids.length) return {};
  return Object.fromEntries(
    db
      .prepare(`SELECT ref_id, status FROM bigin_queue WHERE kind = ? AND ref_id IN (${ids.map(() => "?").join(",")})`)
      .all(kind, ...ids)
      .map((r) => [r.ref_id, r.status])
  );
}
