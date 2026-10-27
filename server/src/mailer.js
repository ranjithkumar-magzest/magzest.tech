/* =========================================================
   Magzest server — email
   Sends a notification to the team for every submission and
   (optionally) an auto-reply to the person who submitted.
   If SMTP isn't configured, emails are logged and skipped —
   submissions are still saved and visible in the admin.
   ========================================================= */

import nodemailer from "nodemailer";
import { config } from "./config.js";
import { escapeHtml, adminPath } from "./util.js";

const { mail } = config;
const enabled = Boolean(mail.host && mail.user && mail.pass);

const transport = enabled
  ? nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: { user: mail.user, pass: mail.pass },
    })
  : null;

if (!enabled) console.warn("SMTP not configured — emails will be logged, not sent. Set SMTP_* in server/.env.");

export async function verifyMailer() {
  if (!transport) return { ok: false, error: "SMTP not configured" };
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function send(message) {
  if (!transport) {
    console.log(`[mail skipped] to=${message.to} subject="${message.subject}"`);
    return;
  }
  try {
    await transport.sendMail({ from: mail.from, ...message });
  } catch (err) {
    // Never fail a submission because email is down; it's in the DB.
    console.error(`[mail failed] to=${message.to} subject="${message.subject}": ${err.message}`);
  }
}

// Emails written by an admin (candidate updates, booking confirmations).
// Unlike send(), reports the outcome so the admin UI can show it.
// "text" is plain text typed in the admin; it's escaped and paragraphs kept.
export async function sendAdminEmail({ to, subject, text, icalEvent, attachments }) {
  if (!transport) return { sent: false, error: "SMTP is not configured" };
  const body = String(text || "")
    .split(/\n{2,}/)
    .map((para) => `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
  try {
    await transport.sendMail({ from: mail.from, replyTo: mail.notifyTo, to, subject, text, html: layout(subject.split(" — ")[0], body), icalEvent, attachments });
    return { sent: true };
  } catch (err) {
    console.error(`[mail failed] to=${to} subject="${subject}": ${err.message}`);
    return { sent: false, error: err.message };
  }
}

// Two-step sign-in code. Without SMTP, development logs the code to the
// console so local sign-in still works; production refuses (sent: false).
export async function sendLoginCode({ to, code, ip }) {
  const subject = `${code} is your Magzest admin sign-in code`;
  if (!transport) {
    if (config.isProd) return { sent: false, error: "SMTP is not configured" };
    console.log(`[dev] Admin sign-in code for ${to}: ${code}`);
    return { sent: true };
  }
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const body =
    p("Use this code to finish signing in to the Magzest admin:") +
    `<p style="font-size:32px;font-weight:800;letter-spacing:.3em;margin:8px 0 20px;font-family:ui-monospace,Consolas,monospace">${escapeHtml(code)}</p>` +
    p("It expires in 10 minutes and works once.") +
    p(`<span style="color:#64748b">Requested ${escapeHtml(when)} IST${ip ? ` from ${escapeHtml(ip)}` : ""}. If this wasn't you, someone knows your password: change it in Admin → Settings.</span>`);
  try {
    await transport.sendMail({
      from: mail.from,
      to,
      subject,
      text: `Your Magzest admin sign-in code is ${code}. It expires in 10 minutes. If this wasn't you, change your password.`,
      html: layout("Your sign-in code", body),
    });
    return { sent: true };
  } catch (err) {
    console.error(`[mail failed] sign-in code to=${to}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    <div style="background:#000033;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0;font-weight:800;letter-spacing:.04em;font-size:20px">MAGZEST</div>
    <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:0">
      <h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
    <p style="font-size:12px;color:#64748b;text-align:center;margin-top:16px">Magzest Consultancy Services · Kukatpally, Hyderabad · <a href="${config.siteUrl}" style="color:#64748b">magzest.tech</a></p>
  </div></body></html>`;
}

function fieldsTable(fields) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#64748b;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`
    )
    .join("");
  return `<table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>`;
}

const p = (text) => `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${text}</p>`;

const LABELS = {
  contact: "New contact message",
  application: "New job application",
  booking: "New call booking",
};

export function notifyTeam(type, { name, email, fields, attachment }) {
  const adminLink = `${config.siteUrl}${adminPath()}/`;
  return send({
    to: type === "contact" || type === "booking" ? mail.leadsTo : mail.notifyTo,
    replyTo: email || undefined,
    subject: `${LABELS[type]} — ${name}`,
    html: layout(LABELS[type], fieldsTable({ Name: name, Email: email, ...fields }) + `<p style="margin-top:20px"><a href="${adminLink}" style="background:#000033;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Open admin dashboard</a></p>`),
    attachments: attachment ? [attachment] : undefined,
  });
}

export function notifyTeamSubscriber(email) {
  return send({
    to: mail.notifyTo,
    subject: `New newsletter subscriber — ${email}`,
    html: layout("New newsletter subscriber", fieldsTable({ Email: email })),
  });
}

// Auto-replies go to whatever address the visitor typed, so they must not
// carry text the visitor wrote: otherwise anyone could use the forms to
// send their own message, from our domain, to a stranger. Only fixed
// wording, values we validated, and a plain first name are included.
export function autoReply(type, { name, email, fields, knownPosition }) {
  if (!mail.autoReply) return;
  const firstWord = String(name || "").trim().split(/\s+/)[0];
  const first = /^\p{L}[\p{L}'-]{0,29}$/u.test(firstWord) ? escapeHtml(firstWord) : "there";
  let subject, body;

  if (type === "contact") {
    subject = "We've received your message — Magzest";
    body =
      p(`Hi ${first},`) +
      p("Thanks for reaching out to Magzest. We've received your message and someone from our team will get back to you within one business day.");
  } else if (type === "application") {
    // Only name the role if it's one of our open jobs.
    subject = knownPosition ? `Application received: ${knownPosition} — Magzest` : "Application received — Magzest";
    body =
      p(`Hi ${first},`) +
      p(`Thank you for applying ${knownPosition ? `for the <b>${escapeHtml(knownPosition)}</b> role ` : ""}at Magzest. Our team reviews every application and will contact you if your profile matches what we're looking for.`) +
      p("We appreciate your interest in joining us.");
  } else if (type === "booking") {
    subject = "Your call request is in — Magzest";
    body =
      p(`Hi ${first},`) +
      p(`Thanks for booking a call with Magzest. We've noted your preferred slot of <b>${escapeHtml(fields.Date)}</b> at <b>${escapeHtml(fields.Time)}</b> IST.`) +
      p("We'll confirm the time and share a meeting link shortly. If you need to change anything, just reply to this email.");
  } else {
    return;
  }

  return send({ to: email, replyTo: mail.notifyTo, subject, html: layout(subject.split(" — ")[0], body) });
}

// Double opt-in: nobody is subscribed until they click the link in this
// email, so typing someone else's address only sends them this one note.
// Sent even when AUTO_REPLY=false, since signing up can't finish without it.
export function sendSubscribeConfirmation({ email, confirmUrl }) {
  const subject = "Confirm your subscription — Magzest";
  const body =
    p("Please confirm that you'd like to receive Magzest's tech &amp; growth articles by email.") +
    `<p style="margin:20px 0"><a href="${escapeHtml(confirmUrl)}" style="background:#000033;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Confirm subscription</a></p>` +
    `<p style="font-size:12px;color:#64748b;margin-top:20px">Didn't sign up? Ignore this email and you won't hear from us.</p>`;
  return send({ to: email, replyTo: mail.notifyTo, subject, html: layout("Confirm your subscription", body) });
}
