/* =========================================================
   Create an admin account, or reset an existing one's password.
   Usage: npm run create-admin -- you@magzest.tech "a long password"
   ========================================================= */

import { db } from "../src/db.js";
import { createAdmin, hashPassword } from "../src/auth.js";
import { EMAIL_RE } from "../src/util.js";

const [email, password] = process.argv.slice(2);

if (!email || !password || !EMAIL_RE.test(email) || password.length < 10) {
  console.error('Usage: npm run create-admin -- <email> "<password, 10+ characters>"');
  process.exit(1);
}

const existing = db.prepare("SELECT id FROM admins WHERE email = ?").get(email);
if (existing) {
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(password), existing.id);
  console.log(`Password reset for ${email}`);
} else {
  createAdmin(email, password);
  console.log(`Admin created: ${email}`);
}
