/* =========================================================
   Test helpers: start the real server against a throwaway
   data directory, with email and Bigin sync switched off.
   ========================================================= */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ADMIN = { email: "admin@example.test", password: "correct horse battery" };

// Every setting the server reads is given explicitly, so nothing comes from
// server/.env (already-set variables take precedence over the file).
export function testEnv(dataDir, overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    SITE_URL: "https://www.example.test",
    TRUST_PROXY: "",
    SESSION_SECRET: "test-session-secret",
    DATA_ENCRYPTION_KEY: "test-data-key-0123456789abcdef0123456789",
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_MFA: "true",
    ADMIN_PATH: "",
    SMTP_HOST: "",
    SMTP_USER: "",
    SMTP_PASS: "",
    BIGIN_FORM_XNQSJSDP: "",
    BIGIN_FORM_XMIWTLD: "",
    ...overrides,
  };
}

export function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "magzest-test-"));
}

export async function startServer(overrides = {}) {
  const dataDir = tempDataDir();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: SERVER_DIR,
    env: testEnv(dataDir, { PORT: String(port), ...overrides }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) break;
    } catch {}
    if (i > 100 || child.exitCode !== null) throw new Error("Server didn't start:\n" + output);
    await sleep(100);
  }

  return {
    base,
    dataDir,
    output: () => output,
    async stop() {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny cookie jar: one per simulated browser.
export function browser(base) {
  const cookies = new Map();
  async function request(method, url, { json, form, headers = {} } = {}) {
    const opts = { method, headers: { ...headers }, redirect: "manual" };
    if (cookies.size) opts.headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (json !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(json);
    }
    if (form) {
      opts.body = new FormData();
      for (const [k, v] of Object.entries(form)) opts.body.append(k, v);
    }
    if (method !== "GET") opts.headers["X-Requested-With"] ??= "magzest-admin";
    const res = await fetch(base + url, opts);
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, ...value] = pair.split("=");
      const expired = attrs.some((a) => /^\s*expires=/i.test(a) && Date.parse(a.split("=")[1]) < Date.now());
      if (expired || !value.join("=")) cookies.delete(name.trim());
      else cookies.set(name.trim(), value.join("="));
    }
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body };
  }
  return { request, cookies };
}

// Signs in with password + the emailed code (logged to the console in dev/test).
export async function signIn(server, b, password = ADMIN.password) {
  const before = server.output().length;
  const login = await b.request("POST", "/api/admin/login", { json: { email: ADMIN.email, password } });
  if (login.status !== 200) return login;
  let code;
  for (let i = 0; i < 50 && !code; i++) {
    code = server.output().slice(before).match(/sign-in code for \S+: (\d{6})/)?.[1];
    if (!code) await sleep(50);
  }
  return b.request("POST", "/api/admin/login/verify", { json: { code } });
}
