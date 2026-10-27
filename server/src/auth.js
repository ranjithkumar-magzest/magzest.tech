/* =========================================================
   Magzest server — admin authentication
   Passwords: scrypt with a per-user salt.
   Sessions:  HMAC-signed, HttpOnly, SameSite=Strict cookie
              (no server-side session store needed). Sliding:
              each request while signed in pushes the idle
              deadline forward, up to a fixed maximum length.
   ========================================================= */

import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { nowIso } from "./util.js";

const COOKIE = "mz_admin";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

// Checked against when the email is unknown, so a wrong email takes as
// long as a wrong password and response times don't reveal which admins exist.
const DUMMY_HASH = hashPassword(crypto.randomUUID());

export function verifyPassword(password, stored) {
  if (!stored) return verifyPassword(password, DUMMY_HASH) && false;
  const [scheme, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function createAdmin(email, password) {
  return db
    .prepare("INSERT INTO admins (email, password_hash, created_at) VALUES (?, ?, ?)")
    .run(email.trim(), hashPassword(password), nowIso());
}

// On first boot, create the admin from ADMIN_EMAIL / ADMIN_PASSWORD.
export function bootstrapAdmin() {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM admins").get();
  if (count > 0) return;
  if (config.admin.email && config.admin.password) {
    createAdmin(config.admin.email, config.admin.password);
    console.log(`Created admin account ${config.admin.email}`);
  } else {
    console.warn("No admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in server/.env, or run: npm run create-admin");
  }
}

function sign(payload) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

const cookieOptions = () => ({ httpOnly: true, sameSite: "strict", secure: config.isProd, path: "/" });

// Cookie value: "<adminId>.<issuedMs>.<lastSeenMs>.<signature>". A session
// ends after SESSION_IDLE_MINUTES without a request, or SESSION_HOURS after
// sign-in, whichever comes first.
// Re-issue the cookie at most once a minute (or a quarter of the idle
// window, if shorter), not on every request.
const REFRESH_MS = Math.min(60 * 1000, (config.sessionIdleMinutes * 60 * 1000) / 4);

const sessionExpiry = (issued, seen) =>
  Math.min(seen + config.sessionIdleMinutes * 60 * 1000, issued + config.sessionHours * 3600 * 1000);

export function setSessionCookie(res, adminId, issued = Date.now()) {
  const seen = Date.now();
  const payload = `${adminId}.${issued}.${seen}`;
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, { ...cookieOptions(), expires: new Date(sessionExpiry(issued, seen)) });
}

// Clear with the same attributes it was set with, so the expiring
// Set-Cookie header carries the same security flags.
export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, cookieOptions());
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return null; // malformed %-escape
    }
  }
  return null;
}

function readSession(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [id, issuedRaw, seenRaw, sig] = parts;
  const expected = sign(`${id}.${issuedRaw}.${seenRaw}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const issued = Number(issuedRaw);
  const seen = Number(seenRaw);
  if (sessionExpiry(issued, seen) < Date.now()) return null;
  const row = db.prepare("SELECT id, email, sessions_valid_after FROM admins WHERE id = ?").get(Number(id));
  // Changing the password signs out every session started before it.
  if (!row || issued < row.sessions_valid_after) return null;
  return { admin: { id: row.id, email: row.email }, issued, seen, expiresAt: sessionExpiry(issued, seen) };
}

export function currentAdmin(req) {
  return readSession(req)?.admin || null;
}

// Like currentAdmin, but counts the request as activity and slides the
// idle deadline forward. Returns { admin, expiresAt } or null.
export function touchSession(req, res) {
  const session = readSession(req);
  if (!session) return null;
  if (Date.now() - session.seen > REFRESH_MS) {
    setSessionCookie(res, session.admin.id, session.issued);
    session.expiresAt = sessionExpiry(session.issued, Date.now());
  }
  return { admin: session.admin, expiresAt: session.expiresAt };
}

// Ends every other session of this admin (after a password change) and
// gives the current browser a fresh one.
export function revokeOtherSessions(res, adminId) {
  const now = Date.now();
  db.prepare("UPDATE admins SET sessions_valid_after = ? WHERE id = ?").run(now, adminId);
  setSessionCookie(res, adminId, now);
}

// Guards /api/admin/*. State-changing requests must also carry the
// X-Requested-With header the admin UI sends — a cross-site form can't
// set custom headers, so together with SameSite=Strict this blocks CSRF.
export function requireAdmin(req, res, next) {
  const admin = touchSession(req, res)?.admin;
  if (!admin) return res.status(401).json({ ok: false, error: "Not signed in." });
  if (req.method !== "GET" && req.get("X-Requested-With") !== "magzest-admin") {
    return res.status(403).json({ ok: false, error: "Missing request header." });
  }
  req.admin = admin;
  next();
}

/* ---------- Two-step sign-in (emailed code) ---------- */

// After a correct password the browser gets a random token in a short-lived
// HttpOnly cookie, and a 6-digit code is emailed. Both are needed to get a
// session. Only hashes are stored; a challenge allows 5 tries in 10 minutes.
const LOGIN_COOKIE = "mz_login";
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const loginCookieOptions = () => ({ httpOnly: true, sameSite: "strict", secure: config.isProd, path: "/api/admin" });

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const codeHash = (token, code) => crypto.createHmac("sha256", config.sessionSecret).update(`${token}:${code}`).digest("hex");

export function startLoginChallenge(res, adminId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expires = Date.now() + CODE_MINUTES * 60 * 1000;
  db.prepare("DELETE FROM login_codes WHERE expires_at < ? OR admin_id = ?").run(Date.now(), adminId);
  db.prepare("INSERT INTO login_codes (token_hash, admin_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(token),
    adminId,
    codeHash(token, code),
    expires,
    nowIso()
  );
  res.cookie(LOGIN_COOKIE, token, { ...loginCookieOptions(), expires: new Date(expires) });
  return { code, cancel: () => db.prepare("DELETE FROM login_codes WHERE token_hash = ?").run(sha256(token)) };
}

// Returns { admin } on success, or { error } with a message for the user.
export function verifyLoginChallenge(req, res, code) {
  const token = readCookie(req, LOGIN_COOKIE);
  const row = token && db.prepare("SELECT * FROM login_codes WHERE token_hash = ?").get(sha256(token));
  if (!row || row.expires_at < Date.now()) return { error: "This code has expired. Sign in again to get a new one.", restart: true };
  const expected = Buffer.from(row.code_hash);
  const actual = Buffer.from(codeHash(token, String(code || "").replace(/\D/g, "")));
  if (!crypto.timingSafeEqual(expected, actual)) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare("DELETE FROM login_codes WHERE token_hash = ?").run(row.token_hash);
      res.clearCookie(LOGIN_COOKIE, loginCookieOptions());
      return { error: "Too many wrong codes. Sign in again to get a new one.", restart: true };
    }
    db.prepare("UPDATE login_codes SET attempts = ? WHERE token_hash = ?").run(attempts, row.token_hash);
    return { error: `That code isn't right. ${MAX_ATTEMPTS - attempts} ${MAX_ATTEMPTS - attempts === 1 ? "try" : "tries"} left.` };
  }
  db.prepare("DELETE FROM login_codes WHERE token_hash = ?").run(row.token_hash);
  res.clearCookie(LOGIN_COOKIE, loginCookieOptions());
  const admin = db.prepare("SELECT id, email FROM admins WHERE id = ?").get(row.admin_id);
  return admin ? { admin } : { error: "This account no longer exists.", restart: true };
}
