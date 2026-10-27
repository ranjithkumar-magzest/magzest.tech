/* =========================================================
   Magzest server — SQLite database
   Uses Node's built-in node:sqlite (no native modules to
   compile), so it runs on any host with Node >= 22.13.
   ========================================================= */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { seedContent } from "./seed.js";
import { ENCRYPTED_COLUMNS, encrypt, decrypt, isEncrypted, emailIndex, encryptBuffer, isEncryptedFile } from "./crypto.js";

export const db = new DatabaseSync(config.dbFile);
// secure_delete zeroes deleted/overwritten data instead of leaving it in free pages.
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  -- contact messages, job applications and call bookings share one table;
  -- type-specific fields live in the JSON "data" column.
  CREATE TABLE IF NOT EXISTS submissions (
    id         INTEGER PRIMARY KEY,
    type       TEXT NOT NULL CHECK (type IN ('contact', 'application', 'booking')),
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived')),
    data       TEXT NOT NULL DEFAULT '{}',
    notes      TEXT NOT NULL DEFAULT '',
    file_path  TEXT,
    file_name  TEXT,
    ip         TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submissions_type_created ON submissions (type, created_at DESC);

  CREATE TABLE IF NOT EXISTS subscribers (
    id         INTEGER PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'unsubscribed')),
    token      TEXT NOT NULL UNIQUE,
    source     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id              INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    location        TEXT NOT NULL DEFAULT 'Remote',
    employment_type TEXT NOT NULL DEFAULT 'Full-time',
    stack           TEXT NOT NULL DEFAULT '',
    icon            TEXT NOT NULL DEFAULT 'briefcase',
    is_open         INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id           INTEGER PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT '',
    excerpt      TEXT NOT NULL DEFAULT '',
    cover_image  TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'coming_soon', 'published')),
    published_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id             INTEGER PRIMARY KEY,
    title          TEXT NOT NULL,
    category       TEXT NOT NULL,
    category_label TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'Web App',
    description    TEXT NOT NULL DEFAULT '',
    tags           TEXT NOT NULL DEFAULT '',
    mockup_html    TEXT NOT NULL DEFAULT '',
    image          TEXT NOT NULL DEFAULT '',
    is_visible     INTEGER NOT NULL DEFAULT 1,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Run a function inside a transaction (node:sqlite has no helper for this).
export function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* ---------- v2: hiring pipeline, leads CRM, bookings, analytics ---------- */

// Adds a column to an existing database only if it's missing.
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// "stage" is the pipeline position: hiring stages for applications,
// sales stages for contact messages and bookings (see routes/ops.js).
addColumn("submissions", "stage", "TEXT NOT NULL DEFAULT 'new'");
addColumn("submissions", "rating", "INTEGER NOT NULL DEFAULT 0");
addColumn("submissions", "deal_value", "INTEGER NOT NULL DEFAULT 0");
addColumn("submissions", "follow_up", "TEXT");
// Bookings: the held IST slot ("YYYY-MM-DD HH:MM") and its state.
addColumn("submissions", "slot", "TEXT");
addColumn("submissions", "booking_status", "TEXT");
addColumn("submissions", "meeting_link", "TEXT NOT NULL DEFAULT ''");

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS submissions_slot ON submissions (slot) WHERE slot IS NOT NULL;

  CREATE TABLE IF NOT EXISTS activity (
    id            INTEGER PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('note', 'stage', 'email', 'booking')),
    text          TEXT NOT NULL,
    admin_email   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activity_submission ON activity (submission_id, created_at);

  CREATE TABLE IF NOT EXISTS page_views (
    day   TEXT NOT NULL,
    path  TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path)
  );
  CREATE TABLE IF NOT EXISTS visitors (
    day  TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (day, hash)
  );
  CREATE TABLE IF NOT EXISTS referrers (
    day    TEXT NOT NULL,
    source TEXT NOT NULL,
    visits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, source)
  );
`);

/* ---------- v3: vlogs ---------- */

// video_url is either an uploaded file ("uploads/videos/<file>") or a
// YouTube / Vimeo link — see videoSource() in util.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS vlogs (
    id           INTEGER PRIMARY KEY,
    title        TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    video_url    TEXT NOT NULL,
    thumbnail    TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    published_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
`);

/* ---------- v4: emailed sign-in codes (two-step login) ---------- */

// One row per pending sign-in. Only hashes are stored: the browser holds
// the token (HttpOnly cookie) and the code arrives by email.
db.exec(`
  CREATE TABLE IF NOT EXISTS login_codes (
    token_hash TEXT PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Bookings made before slots existed: hold their slot (first one wins).
db.exec(`
  UPDATE OR IGNORE submissions
  SET booking_status = 'pending',
      slot = json_extract(data, '$.date') || ' ' || json_extract(data, '$.time')
  WHERE type = 'booking' AND booking_status IS NULL AND json_valid(data);
  UPDATE submissions SET booking_status = 'pending' WHERE type = 'booking' AND booking_status IS NULL;
`);

// Sessions started before this time (ms) are invalid; bumped on password change.
addColumn("admins", "sessions_valid_after", "INTEGER NOT NULL DEFAULT 0");

/* ---------- v5: encryption at rest (see crypto.js) ---------- */

// Subscriber emails are encrypted, so lookups and uniqueness go through
// a keyed hash of the address instead.
addColumn("subscribers", "email_hash", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS subscribers_email_hash ON subscribers (email_hash)");

// Encrypt anything still stored in plaintext. Runs on every start but only
// touches rows that need it, so an interrupted run simply resumes.
function encryptExistingData() {
  let rows = 0;
  transaction(() => {
    for (const [table, cols] of Object.entries(ENCRYPTED_COLUMNS)) {
      const update = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`);
      for (const row of db.prepare(`SELECT id, ${cols.join(", ")} FROM ${table}`).all()) {
        if (cols.every((c) => row[c] === null || row[c] === "" || isEncrypted(row[c]))) continue;
        update.run(...cols.map((c) => (row[c] === "" ? "" : encrypt(row[c]))), row.id);
        rows++;
      }
    }
    const setHash = db.prepare("UPDATE subscribers SET email_hash = ? WHERE id = ?");
    for (const s of db.prepare("SELECT id, email FROM subscribers WHERE email_hash IS NULL").all()) {
      setHash.run(emailIndex(decrypt(s.email)), s.id);
    }
  });
  let files = 0;
  for (const name of fs.readdirSync(config.resumeDir)) {
    const file = path.join(config.resumeDir, name);
    const buf = fs.readFileSync(file);
    if (isEncryptedFile(buf)) continue;
    fs.writeFileSync(file + ".tmp", encryptBuffer(buf));
    fs.renameSync(file + ".tmp", file);
    files++;
  }
  if (rows) {
    // Rewrite the file so no plaintext copies survive in old pages or the WAL.
    db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
  }
  if (rows || files) console.log(`Encrypted ${rows} database rows and ${files} resume files.`);
}
encryptExistingData();

/* ---------- v6: newsletter double opt-in ---------- */

// New sign-ups are 'pending' until they click the emailed confirmation
// link. SQLite can't change a CHECK constraint in place, so older
// databases get the subscribers table rebuilt with the new status allowed.
const subscribersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscribers'").get().sql;
if (!subscribersSql.includes("'pending'")) {
  const cols = "id, email, status, token, source, created_at, email_hash";
  transaction(() => {
    db.exec(`
      CREATE TABLE subscribers_v6 (
        id         INTEGER PRIMARY KEY,
        email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'unsubscribed')),
        token      TEXT NOT NULL UNIQUE,
        source     TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        email_hash TEXT
      );
      INSERT INTO subscribers_v6 (${cols}) SELECT ${cols} FROM subscribers;
      DROP TABLE subscribers;
      ALTER TABLE subscribers_v6 RENAME TO subscribers;
      CREATE UNIQUE INDEX subscribers_email_hash ON subscribers (email_hash);
    `);
  });
}

// First run: import the jobs, blog cards and portfolio projects that are
// currently hard-coded in the HTML, so the site looks identical until
// someone edits content in the admin.
const seeded = db.prepare("SELECT value FROM meta WHERE key = 'content_seeded'").get();
if (!seeded) {
  transaction(() => {
    seedContent(db);
    db.prepare("INSERT INTO meta (key, value) VALUES ('content_seeded', ?)").run(new Date().toISOString());
  });
}
