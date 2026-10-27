/*
 * Builds the deploy ZIP for the VPS: dist/magzest-deploy-<date>.zip
 *
 * Run build.ps1 first so the built pages/CSS/JS are current, then:
 *   node deploy/make-bundle.mjs
 *
 * Includes only what the server needs at runtime: the built pages,
 * css/, js/, assets/, templates/ and pages/ (read by the server),
 * server/ and deploy/setup-vps.sh. Never includes node_modules,
 * local databases (server/data*), .env files or build tools.
 *
 * On the VPS:
 *   unzip magzest-deploy-<date>.zip && sudo bash magzest/deploy/setup-vps.sh
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const INCLUDE_DIRS = ["css", "js", "assets", "templates", "pages", "server"];
const INCLUDE_ROOT = (name) => name.endsWith(".html") || ["robots.txt", "sitemap.xml", "favicon.ico"].includes(name);
const EXCLUDE_PARTS = new Set(["node_modules", ".git", "__pycache__"]);

function excluded(rel) {
  const parts = rel.split("/");
  if (parts.some((p) => EXCLUDE_PARTS.has(p))) return true;
  if (parts[0] === "server" && parts.length > 1 && (parts[1].startsWith("data") || (parts[1].startsWith(".env") && parts[1] !== ".env.example"))) return true;
  return /\.(log|db|db-wal|db-shm)$/.test(rel);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function* files() {
  for (const name of fs.readdirSync(ROOT).sort()) if (INCLUDE_ROOT(name)) yield path.join(ROOT, name);
  for (const d of INCLUDE_DIRS) {
    for (const file of walk(path.join(ROOT, d))) if (!excluded(path.relative(ROOT, file).split(path.sep).join("/"))) yield file;
  }
  yield path.join(ROOT, "deploy", "setup-vps.sh");
}

// Minimal ZIP writer (deflate, Unix permissions so setup-vps.sh stays executable).
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mtime, mode } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const { time, date } = dosTime(mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below is honoured
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const entries = [...files()].map((file) => {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  let data = fs.readFileSync(file);
  let mode = 0o644;
  if (rel.endsWith(".sh")) {
    data = Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1"); // bash breaks on CRLF
    mode = 0o755;
  }
  return { name: `magzest/${rel}`, data, mtime: fs.statSync(file).mtime, mode };
});

fs.mkdirSync(DIST, { recursive: true });
const today = new Date();
const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const out = path.join(DIST, `magzest-deploy-${stamp}.zip`);
fs.writeFileSync(out, zip(entries));
console.log(`Wrote ${path.relative(ROOT, out)} (${entries.length} files, ${Math.floor(fs.statSync(out).size / 1024)} KB)`);
