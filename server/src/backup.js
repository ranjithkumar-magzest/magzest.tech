/* =========================================================
   Magzest server — automatic database backups
   Writes a consistent snapshot (VACUUM INTO) to
   DATA_DIR/backups once a day and keeps the newest 14.
   Personal data in them is encrypted, so restoring one needs
   the same DATA_ENCRYPTION_KEY. Uploaded files (resumes,
   images) are not included — back up DATA_DIR/uploads with
   your host's disk snapshots.
   ========================================================= */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

export const backupDir = path.join(config.dataDir, "backups");
const KEEP = 14;
const DAY_MS = 24 * 3600 * 1000;

export function listBackups() {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => /^magzest-[\d-]+\.db$/.test(f))
    .map((name) => {
      const stat = fs.statSync(path.join(backupDir, name));
      return { name, size: stat.size, created_at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function runBackup() {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = path.join(backupDir, `magzest-${stamp}.db`);
  db.prepare("VACUUM INTO ?").run(file);
  for (const old of listBackups().slice(KEEP)) fs.rmSync(path.join(backupDir, old.name), { force: true });
  return listBackups()[0];
}

// Back up now if the newest backup is over a day old, then check hourly.
export function scheduleBackups() {
  const check = () => {
    try {
      const latest = listBackups()[0];
      if (!latest || Date.now() - Date.parse(latest.created_at) > DAY_MS) {
        const b = runBackup();
        console.log(`Database backup written: ${b.name}`);
      }
    } catch (err) {
      console.error("Backup failed:", err.message);
    }
  };
  check();
  setInterval(check, 3600 * 1000).unref();
}
