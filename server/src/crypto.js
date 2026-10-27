/* =========================================================
   Magzest server — encryption at rest
   Personal data (form submissions, subscriber emails, CRM
   notes, IPs, resumes) is stored AES-256-GCM encrypted with
   DATA_ENCRYPTION_KEY. Without the key, the database file,
   its backups and the uploaded resumes are unreadable.

   Encrypted text looks like "enc1:<base64url iv|tag|data>".
   Values without that prefix are legacy plaintext and are
   returned as-is, so old rows keep working until migrated.
   ========================================================= */

import crypto from "node:crypto";
import { config } from "./config.js";

const PREFIX = "enc1:";
const FILE_MAGIC = Buffer.from("MZENC1\0");
const IV_LEN = 12;
const TAG_LEN = 16;

// Separate keys for encryption and for the email lookup hash.
const encKey = crypto.createHmac("sha256", config.dataKey).update("magzest:encrypt").digest();
const indexKey = crypto.createHmac("sha256", config.dataKey).update("magzest:index").digest();

function seal(plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function open(sealed) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey, sealed.subarray(0, IV_LEN));
  decipher.setAuthTag(sealed.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(sealed.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

export const isEncrypted = (value) => typeof value === "string" && value.startsWith(PREFIX);

// null/undefined stay as they are so nullable columns keep their meaning.
export function encrypt(value) {
  if (value === null || value === undefined || isEncrypted(value)) return value;
  return PREFIX + seal(Buffer.from(String(value), "utf8")).toString("base64url");
}

export function decrypt(value) {
  if (!isEncrypted(value)) return value;
  return open(Buffer.from(value.slice(PREFIX.length), "base64url")).toString("utf8");
}

// Deterministic keyed hash, so an encrypted email can still be looked up
// and kept unique without storing it in plaintext.
export function emailIndex(email) {
  return crypto.createHmac("sha256", indexKey).update(String(email).trim().toLowerCase()).digest("base64url");
}

/* ---------- Files (resumes) ---------- */

export const isEncryptedFile = (buf) => buf.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);

export const encryptBuffer = (buf) => (isEncryptedFile(buf) ? buf : Buffer.concat([FILE_MAGIC, seal(buf)]));

export const decryptBuffer = (buf) => (isEncryptedFile(buf) ? open(buf.subarray(FILE_MAGIC.length)) : buf);

/* ---------- Row helpers ---------- */

// Columns holding personal data, per table.
export const ENCRYPTED_COLUMNS = {
  submissions: ["name", "email", "data", "notes", "ip", "file_name", "meeting_link"],
  subscribers: ["email"],
  activity: ["text"],
};

// Returns a copy of a DB row with its encrypted columns decrypted.
export function decryptRow(table, row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of ENCRYPTED_COLUMNS[table]) if (col in out) out[col] = decrypt(out[col]);
  return out;
}
