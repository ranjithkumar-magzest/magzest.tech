import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { testEnv, tempDataDir } from "./helpers.js";

// crypto.js reads its key from config.js, so set the environment before
// importing it (dynamic import runs after this line, static imports wouldn't).
const dataDir = tempDataDir();
Object.assign(process.env, testEnv(dataDir));
const { escapeHtml, slugify, str, toCsv, videoSource } = await import("../src/util.js");
const { encrypt, decrypt, isEncrypted, emailIndex, encryptBuffer, decryptBuffer } = await import("../src/crypto.js");
const { buildInvite } = await import("../src/booking.js");

// Best effort: on Windows the database file stays locked until this process exits.
after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
});

test("slugify makes URL-safe slugs", () => {
  assert.equal(slugify("  SEO & Ads: Café Guide 2026! "), "seo-and-ads-cafe-guide-2026");
  assert.equal(slugify(""), "");
  assert.equal(slugify("x".repeat(200)).length, 80);
});

test("str trims, caps length and ignores non-strings", () => {
  assert.equal(str("  hi  "), "hi");
  assert.equal(str("abcdef", 3), "abc");
  assert.equal(str({ evil: true }), "");
});

test("toCsv quotes cells and defuses spreadsheet formulas", () => {
  const csv = toCsv([{ a: '=HYPERLINK("x")', b: "plain, with comma" }], [
    { label: "A", get: (r) => r.a },
    { label: "B", get: (r) => r.b },
  ]);
  const [, row] = csv.replace(/^﻿/, "").split("\r\n");
  assert.equal(row, `"'=HYPERLINK(""x"")","plain, with comma"`);
});

test("videoSource accepts uploads, YouTube and Vimeo only", () => {
  assert.equal(videoSource("uploads/videos/demo-1a2b.mp4").type, "file");
  assert.equal(videoSource("https://youtu.be/dQw4w9WgXcQ").src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(videoSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(videoSource("https://vimeo.com/123456789").type, "vimeo");
  assert.equal(videoSource("javascript:alert(1)"), null);
  assert.equal(videoSource("https://evil.example/video.mp4"), null);
  assert.equal(videoSource("uploads/videos/../../etc/passwd"), null);
});

test("encrypt/decrypt round-trips and is randomised", () => {
  const a = encrypt("asha@example.test");
  const b = encrypt("asha@example.test");
  assert.ok(isEncrypted(a));
  assert.notEqual(a, b);
  assert.equal(decrypt(a), "asha@example.test");
  assert.equal(encrypt(null), null);
  assert.equal(encrypt(a), a, "already-encrypted values aren't double-encrypted");
  assert.equal(decrypt("legacy plaintext"), "legacy plaintext");
});

test("tampered ciphertext is rejected", () => {
  const value = encrypt("secret");
  const tampered = value.slice(0, -2) + (value.endsWith("A") ? "BB" : "AA");
  assert.throws(() => decrypt(tampered));
});

test("emailIndex ignores case and surrounding spaces", () => {
  assert.equal(emailIndex(" Asha@Example.TEST "), emailIndex("asha@example.test"));
  assert.notEqual(emailIndex("a@example.test"), emailIndex("b@example.test"));
});

test("file encryption round-trips", () => {
  const original = Buffer.from("%PDF-1.7 resume");
  const sealed = encryptBuffer(original);
  assert.ok(!sealed.includes(original));
  assert.deepEqual(decryptBuffer(sealed), original);
  assert.deepEqual(encryptBuffer(sealed), sealed);
});

test("calendar invites convert IST to UTC and fold long lines", () => {
  const ics = buildInvite({
    uid: "u@x",
    date: "2026-11-02",
    time: "10:30",
    minutes: 30,
    summary: "Call",
    description: "x".repeat(200),
    organizer: "team@example.test",
    attendee: { name: "Asha", email: "asha@example.test" },
  });
  assert.match(ics, /DTSTART:20261102T050000Z/);
  assert.match(ics, /DTEND:20261102T053000Z/);
  for (const line of ics.split("\r\n")) assert.ok(line.length <= 75, `line too long: ${line.length}`);
});
