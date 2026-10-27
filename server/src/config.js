/* =========================================================
   Magzest server — configuration
   Reads server/.env (if present) into process.env, then
   exposes typed settings. See .env.example for every key.
   ========================================================= */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(SERVER_DIR, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const isProd = env.NODE_ENV === "production";

const DATA_DIR = path.resolve(SERVER_DIR, env.DATA_DIR || "data");
fs.mkdirSync(path.join(DATA_DIR, "uploads", "resumes"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "uploads", "media", "videos"), { recursive: true });

// The session secret signs admin login cookies. In production it must be
// set explicitly; in development one is generated once and kept in data/.
function sessionSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (isProd) throw new Error("SESSION_SECRET must be set in production (see server/.env.example).");
  const file = path.join(DATA_DIR, ".session-secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"));
  return fs.readFileSync(file, "utf8").trim();
}

// The data key encrypts personal data in the database and resumes on disk.
// Losing it means losing that data, so in production it must be set (and
// backed up) explicitly; in development one is generated once in data/.
function dataKey() {
  const fromEnv = env.DATA_ENCRYPTION_KEY;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("DATA_ENCRYPTION_KEY must be at least 32 characters (see server/.env.example).");
    return fromEnv;
  }
  if (isProd) throw new Error("DATA_ENCRYPTION_KEY must be set in production (see server/.env.example).");
  const file = path.join(DATA_DIR, ".data-key");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"));
  return fs.readFileSync(file, "utf8").trim();
}

export const config = {
  isProd,
  port: Number(env.PORT) || 3000,
  // Number of reverse proxies in front of the app (Render/Railway/Nginx = 1).
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0,
  siteUrl: (env.SITE_URL || "https://www.magzest.tech").replace(/\/$/, ""),

  serverDir: SERVER_DIR,
  siteRoot: path.resolve(SERVER_DIR, ".."),
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, "magzest.db"),
  resumeDir: path.join(DATA_DIR, "uploads", "resumes"),
  mediaDir: path.join(DATA_DIR, "uploads", "media"),
  // Vlog videos; served at /uploads/videos/<file> like the images.
  videoDir: path.join(DATA_DIR, "uploads", "media", "videos"),

  sessionSecret: sessionSecret(),
  // Admin sessions end after this long without activity, and in any case
  // this many hours after sign-in.
  sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES) || 120,
  sessionHours: Number(env.SESSION_HOURS) || 168,
  dataKey: dataKey(),

  admin: {
    email: env.ADMIN_EMAIL || "",
    password: env.ADMIN_PASSWORD || "",
    // Two-step sign-in: after the password, a 6-digit code is emailed to
    // the admin. On by default; ADMIN_MFA=false turns it off.
    mfa: env.ADMIN_MFA !== "false",
  },

  mail: {
    host: env.SMTP_HOST || "",
    port: Number(env.SMTP_PORT) || 465,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : (Number(env.SMTP_PORT) || 465) === 465,
    user: env.SMTP_USER || "",
    pass: env.SMTP_PASS || "",
    from: env.MAIL_FROM || "Magzest <contact@magzest.tech>",
    notifyTo: env.NOTIFY_EMAIL || "contact@magzest.tech",
    // Contact-form and consultation-booking alerts go to the whole sales team.
    leadsTo: (env.LEADS_EMAIL || "ranjithkumar@magzest.in,nithin@magzest.tech,hameed@magzest.tech,srilatha@magzest.tech,harini@magzest.tech")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    autoReply: env.AUTO_REPLY !== "false",
  },
};
