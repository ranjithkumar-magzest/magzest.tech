/* =========================================================
   Magzest server — call booking availability + invites
   All times are India Standard Time (UTC+05:30, no DST), so
   slot maths is done on plain "YYYY-MM-DD" / "HH:MM" strings
   and converted to UTC only when building calendar invites.
   ========================================================= */

import crypto from "node:crypto";
import { db } from "./db.js";

const IST_OFFSET_MIN = 330;

export const DEFAULT_SETTINGS = {
  slotMinutes: 30,
  minNoticeHours: 4,
  maxDaysAhead: 21,
  // 0 = Sunday … 6 = Saturday; null = closed
  hours: {
    0: null,
    1: ["10:00", "18:00"],
    2: ["10:00", "18:00"],
    3: ["10:00", "18:00"],
    4: ["10:00", "18:00"],
    5: ["10:00", "18:00"],
    6: ["10:00", "14:00"],
  },
  blockedDates: [],
  meetingLink: "",
};

export function getSettings() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'booking_settings'").get();
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function saveSettings(input) {
  const s = getSettings();
  const clampInt = (v, min, max, fallback) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  if (input.slotMinutes !== undefined) s.slotMinutes = [15, 20, 30, 45, 60, 90].includes(Number(input.slotMinutes)) ? Number(input.slotMinutes) : 30;
  if (input.minNoticeHours !== undefined) s.minNoticeHours = clampInt(input.minNoticeHours, 0, 168, 4);
  if (input.maxDaysAhead !== undefined) s.maxDaysAhead = clampInt(input.maxDaysAhead, 1, 90, 21);
  if (input.hours !== undefined) {
    const hours = {};
    for (let d = 0; d < 7; d++) {
      const v = input.hours[d];
      hours[d] = Array.isArray(v) && TIME_RE.test(v[0]) && TIME_RE.test(v[1]) && v[0] < v[1] ? [v[0], v[1]] : null;
    }
    s.hours = hours;
  }
  if (input.blockedDates !== undefined) {
    s.blockedDates = [...new Set((input.blockedDates || []).filter((d) => DATE_RE.test(d)))].sort();
  }
  if (input.meetingLink !== undefined) s.meetingLink = /^https:\/\/\S+$/.test(input.meetingLink) ? input.meetingLink.slice(0, 500) : "";
  db.prepare("INSERT INTO meta (key, value) VALUES ('booking_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
  return s;
}

/* ---------- IST helpers ---------- */

// Current IST wall-clock time as { date: "YYYY-MM-DD", minutes: minutes since midnight }.
export function istNow() {
  const d = new Date(Date.now() + IST_OFFSET_MIN * 60000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const weekday = (date) => new Date(date + "T00:00:00Z").getUTCDay();

/* ---------- Availability ---------- */

function takenSlots(fromDate, toDate) {
  return new Set(
    db
      .prepare("SELECT slot FROM submissions WHERE slot IS NOT NULL AND slot >= ? AND slot <= ?")
      .all(fromDate, toDate + " 99:99")
      .map((r) => r.slot)
  );
}

// Free slots for every bookable day, starting today (IST).
export function availability() {
  const s = getSettings();
  const now = istNow();
  // Earliest bookable moment, in minutes from today's IST midnight;
  // minNoticeHours can push it into the following day(s).
  const earliest = now.minutes + s.minNoticeHours * 60;
  const taken = takenSlots(now.date, addDays(now.date, s.maxDaysAhead));
  const days = [];
  for (let i = 0; i <= s.maxDaysAhead; i++) {
    const date = addDays(now.date, i);
    const window = s.hours[weekday(date)];
    if (!window || s.blockedDates.includes(date)) continue;
    const slots = [];
    for (let m = toMin(window[0]); m + s.slotMinutes <= toMin(window[1]); m += s.slotMinutes) {
      const t = toTime(m);
      if (i * 1440 + m >= earliest && !taken.has(`${date} ${t}`)) slots.push(t);
    }
    if (slots.length) days.push({ date, slots });
  }
  return { timezone: "Asia/Kolkata", label: "IST", slotMinutes: s.slotMinutes, days };
}

export function isSlotAvailable(date, time) {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return false;
  const day = availability().days.find((d) => d.date === date);
  return Boolean(day && day.slots.includes(time));
}

/* ---------- Calendar invites (.ics) ---------- */

function icsDate(date, time, plusMinutes = 0) {
  const utc = new Date(Date.parse(`${date}T${time}:00Z`) - IST_OFFSET_MIN * 60000 + plusMinutes * 60000);
  return utc.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

// Lines longer than 75 octets must be folded (RFC 5545 §3.1).
function fold(line) {
  const parts = [];
  while (line.length > 74) {
    parts.push(line.slice(0, 74));
    line = " " + line.slice(74);
  }
  parts.push(line);
  return parts.join("\r\n");
}

export function buildInvite({ uid, date, time, minutes, summary, description, url, organizer, attendee, method = "REQUEST", sequence = 0 }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Magzest//Booking//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    `DTSTART:${icsDate(date, time)}`,
    `DTEND:${icsDate(date, time, minutes)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    url ? `URL:${icsText(url)}` : null,
    url ? `LOCATION:${icsText(url)}` : null,
    `ORGANIZER;CN=Magzest:mailto:${organizer}`,
    `ATTENDEE;CN=${icsText(attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=${method === "CANCEL" ? "DECLINED" : "ACCEPTED"};RSVP=FALSE:mailto:${attendee.email}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function bookingUid(id) {
  return `booking-${id}-${crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 10)}@magzest.tech`;
}
