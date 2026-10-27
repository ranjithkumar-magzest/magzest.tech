/* =========================================================
   Magzest Admin — single-page dashboard (no build step)
   All DOM is built with h(), which sets text via textContent,
   so submitted data can never inject markup into the admin.
   ========================================================= */

(function () {
  "use strict";

  const API = "/api/admin";
  const $ = (sel, root = document) => root.querySelector(sel);
  const main = $("#main");

  /* ---------- Helpers ---------- */

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else if (key in el && typeof value !== "string") el[key] = value;
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // Icons live in the <svg> sprite in index.html.
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ic" + (cls ? " " + cls : ""));
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#i-" + name);
    svg.append(use);
    return svg;
  }

  const emptyState = (iconName, title, text) => h("div", { class: "empty" }, icon(iconName), h("b", null, title), text && h("span", null, text));

  async function api(method, url, body) {
    const opts = { method, headers: { "X-Requested-With": "magzest-admin" } };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(API + url, opts);
    if (res.status === 401 && !url.startsWith("/login")) {
      sessionExpired();
      throw new Error("Your session expired — please sign in again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || "Something went wrong."), { data });
    return data;
  }

  let toastTimer;
  function toast(message, isError) {
    const el = $("#toast");
    el.replaceChildren(icon(isError ? "alert" : "check"), h("span", null, message));
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 3200);
  }
  const fail = (err) => toast(err.message, true);

  function fmtDate(iso, withTime = true) {
    if (!iso) return "—";
    const d = new Date(iso);
    const opts = { day: "numeric", month: "short", year: "numeric" };
    if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
    return d.toLocaleString("en-IN", opts);
  }

  const badge = (status, label) => h("span", { class: `badge badge-${status}` }, label || status.replace("_", " "));
  const siteUrl = (path) => (!path ? "" : /^https?:/.test(path) ? path : "/" + path.replace(/^\//, ""));
  const slugify = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  function pageHead(title, subtitle, ...actions) {
    return h("div", { class: "page-head" }, h("div", null, h("h1", null, title), subtitle && h("p", null, subtitle)), h("div", { class: "actions" }, actions));
  }

  function drawer(title, body, foot) {
    const close = () => overlay.remove();
    const overlay = h(
      "div",
      { class: "overlay", onclick: (e) => e.target === overlay && close() },
      h(
        "div",
        { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("div", { class: "drawer-head" }, h("h2", { style: "margin:0" }, title), h("button", { class: "close", "aria-label": "Close", onclick: close }, "×")),
        h("div", { class: "drawer-body" }, body),
        foot && h("div", { class: "drawer-foot" }, foot)
      )
    );
    const onKey = (e) => {
      if (e.key === "Escape" && document.body.contains(overlay)) {
        close();
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    return { close, el: overlay };
  }

  /* ---------- Auth ---------- */

  function showLogin() {
    $("#app-view").hidden = true;
    $("#login-view").hidden = false;
    showPasswordStep();
    document.querySelectorAll(".overlay").forEach((o) => o.remove());
  }

  // Session ran out mid-work: show the sign-in screen but keep the page and
  // any open editor (hidden), so signing in again picks up where it left off.
  function sessionExpired() {
    if ($("#app-view").hidden) return;
    $("#app-view").hidden = true;
    $("#login-view").hidden = false;
    showPasswordStep();
    document.querySelectorAll(".overlay").forEach((o) => (o.hidden = true));
    $("#login-error").textContent = "You were signed out after a period of inactivity. Sign in again — anything you were editing is still here.";
    $("#login-error").hidden = false;
  }

  function showApp() {
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    const kept = document.querySelectorAll(".overlay[hidden]");
    if (kept.length) {
      kept.forEach((o) => (o.hidden = false));
      toast("Signed in again — save your changes to keep them");
    } else route();
    refreshCounts();
    api("GET", "/me")
      .then(({ admin }) => {
        $("#me-email").textContent = admin.email;
        $("#me-avatar").textContent = admin.email.charAt(0);
      })
      .catch(() => {});
  }

  // Sign-in is two steps: password, then the 6-digit code emailed to the
  // admin. The credentials are kept in memory only so "Resend code" works.
  let pending = null;

  function showPasswordStep() {
    pending = null;
    $("#code-form").hidden = true;
    $("#login-form").hidden = false;
    $("#login-form").password.value = "";
  }

  function showCodeStep(sentTo) {
    $("#login-form").hidden = true;
    $("#code-form").hidden = false;
    $("#code-sent-to").textContent = sentTo;
    $("#code-error").hidden = true;
    const input = $("#code-form").code;
    input.value = "";
    input.focus();
  }

  async function requestCode() {
    const res = await api("POST", "/login", pending);
    if (!res.mfa) {
      pending = null;
      return showApp();
    }
    showCodeStep(res.sentTo);
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = $("#login-error");
    const button = form.querySelector("button[type=submit]");
    err.hidden = true;
    button.disabled = true;
    pending = { email: form.email.value, password: form.password.value };
    try {
      await requestCode();
    } catch (ex) {
      pending = null;
      err.textContent = ex.message;
      err.hidden = false;
    }
    button.disabled = false;
  });

  $("#code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = $("#code-error");
    const button = form.querySelector("button[type=submit]");
    err.hidden = true;
    button.disabled = true;
    try {
      await api("POST", "/login/verify", { code: form.code.value });
      pending = null;
      $("#login-form").password.value = "";
      $("#code-form").hidden = true;
      $("#login-form").hidden = false;
      showApp();
    } catch (ex) {
      if (ex.data?.restart) {
        showPasswordStep();
        $("#login-error").textContent = ex.message;
        $("#login-error").hidden = false;
      } else {
        err.textContent = ex.message;
        err.hidden = false;
        form.code.select();
      }
    }
    button.disabled = false;
  });

  // Submit as soon as all six digits are in (typed or pasted).
  $("#code-form").code.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    if (e.target.value.length === 6) $("#code-form").requestSubmit();
  });

  $("#code-resend").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!pending) return showPasswordStep();
    btn.disabled = true;
    try {
      await requestCode();
      toast("New code sent");
    } catch (ex) {
      $("#code-error").textContent = ex.message;
      $("#code-error").hidden = false;
    }
    // Brief cooldown so the button can't be hammered.
    setTimeout(() => (btn.disabled = false), 30000);
  });

  $("#code-back").addEventListener("click", showPasswordStep);

  $("#logout").addEventListener("click", async () => {
    await api("POST", "/logout").catch(() => {});
    showLogin();
  });

  function setMenu(open) {
    document.body.classList.toggle("nav-open", open);
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
  }
  $("#menu-toggle").addEventListener("click", () => setMenu(true));
  $("#menu-close").addEventListener("click", () => setMenu(false));
  $("#sidebar-backdrop").addEventListener("click", () => setMenu(false));

  $("#toggle-password").addEventListener("click", (e) => {
    const input = $("#login-form").password;
    input.type = input.type === "password" ? "text" : "password";
    e.currentTarget.setAttribute("aria-label", input.type === "password" ? "Show password" : "Hide password");
  });

  // Theme: follows the system until the user picks one with the toggle.
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function drawThemeToggle() {
    const btn = $("#theme-toggle");
    btn.replaceChildren(icon(isDark() ? "sun" : "moon"));
    btn.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
  }
  $("#theme-toggle").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mz-theme", next);
    } catch {}
    drawThemeToggle();
  });
  drawThemeToggle();

  async function refreshCounts() {
    try {
      const { counts } = await api("GET", "/stats");
      document.querySelectorAll("[data-count]").forEach((el) => {
        const n = counts[el.dataset.count]?.new || 0;
        el.textContent = n ? String(n) : "";
      });
      if (window.MzAdmin && window.MzAdmin.onRefreshCounts) window.MzAdmin.onRefreshCounts();
    } catch {}
  }

  /* ---------- Dashboard ---------- */

  const TYPE_INFO = {
    contact: { title: "Messages", route: "messages", singular: "Message" },
    application: { title: "Applications", route: "applications", singular: "Application" },
    booking: { title: "Bookings", route: "bookings", singular: "Booking" },
  };

  /* ---------- Inbox (contact / application / booking) ---------- */

  const INBOX = {
    contact: {
      columns: [
        ["From", (r) => [h("div", { class: "name" }, r.name), h("div", { class: "sub" }, r.email)]],
        ["Subject", (r) => r.data.subject],
        ["Message", (r) => h("div", { class: "truncate" }, r.data.message)],
      ],
      fields: (r) => [
        ["Mobile", r.data.phone],
        ["City", r.data.city],
        ["State", r.data.state],
        ["Subject", r.data.subject],
        ["Message", r.data.message],
      ],
      replySubject: (r) => `Re: ${r.data.subject || "your message"} — Magzest`,
    },
    application: {
      columns: [
        ["Applicant", (r) => [h("div", { class: "name" }, r.name), h("div", { class: "sub" }, r.email)]],
        ["Position", (r) => r.data.position],
        ["Resume", (r) => (r.has_file ? "📎 " + r.file_name : h("span", { class: "muted" }, "—"))],
      ],
      fields: (r) => [
        ["Position", r.data.position],
        ["Message", r.data.message],
        ["Resume", r.has_file ? h("a", { href: `${API}/submissions/application/${r.id}/resume` }, `Download ${r.file_name}`) : "Not attached"],
      ],
      replySubject: (r) => `Your application for ${r.data.position} — Magzest`,
    },
    booking: {
      columns: [
        ["Name", (r) => [h("div", { class: "name" }, r.name), h("div", { class: "sub" }, r.email)]],
        ["Requested slot", (r) => `${fmtDate(r.data.date + "T00:00", false)} · ${r.data.time}`],
        ["Service", (r) => r.data.service],
        ["Booking", (r) => badge(r.booking_status || "pending")],
      ],
      fields: (r) => [
        ["Date", fmtDate(r.data.date + "T00:00", false)],
        ["Time", `${r.data.time} IST`],
        ["Service", r.data.service],
        ["Booking", h("span", null, badge(r.booking_status || "pending"), " ", h("a", { href: "#/calendar" }, "Manage in Calendar"))],
      ],
      replySubject: () => "Your call with Magzest",
    },
  };

  function inbox(type) {
    const cfg = INBOX[type];
    const info = TYPE_INFO[type];
    const state = { status: "", q: "" };

    return async function render(openId) {
      const tabs = [["", "Active"], ["new", "New"], ["archived", "Archived"], ["all", "All"]];
      const tableHolder = h("div", { class: "table-wrap" });
      let items = [];
      let searchTimer;

      async function load() {
        const params = new URLSearchParams();
        if (state.status) params.set("status", state.status);
        if (state.q) params.set("q", state.q);
        items = (await api("GET", `/submissions/${type}?${params}`)).items;
        drawTable();
      }

      function drawTable() {
        if (!items.length) return tableHolder.replaceChildren(state.q ? emptyState("inbox", "No matches", "Try a different search.") : emptyState("inbox", "Nothing here yet", "New submissions from the website will show up here."));
        tableHolder.replaceChildren(
          h(
            "table",
            null,
            h("thead", null, h("tr", null, cfg.columns.map(([label]) => h("th", null, label)), h("th", null, "Received"), h("th", null, "Status"))),
            h(
              "tbody",
              null,
              items.map((r) =>
                h(
                  "tr",
                  { class: "clickable" + (r.status === "new" ? " unread" : ""), onclick: () => openDetail(r) },
                  cfg.columns.map(([, get]) => h("td", null, get(r))),
                  h("td", { class: "muted", style: "white-space:nowrap" }, fmtDate(r.created_at)),
                  h("td", null, badge(r.status))
                )
              )
            )
          )
        );
      }

      async function update(r, patch) {
        await api("PATCH", `/submissions/${type}/${r.id}`, patch);
        Object.assign(r, patch);
        drawTable();
        refreshCounts();
      }

      function openDetail(r) {
        if (r.status === "new") update(r, { status: "read" }).catch(fail);
        const notes = h("textarea", { rows: 3, placeholder: "Internal notes (only visible here)" }, r.notes);
        const mailto = `mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(cfg.replySubject(r))}`;
        let d;
        const statusBtn = (status, label) =>
          h("button", { class: "btn btn-sm", disabled: r.status === status, onclick: () => update(r, { status }).then(() => (d.close(), toast(`Marked as ${status}`))).catch(fail) }, label);

        d = drawer(
          `${info.singular} from ${r.name}`,
          [
            h(
              "dl",
              { class: "fields" },
              [["Name", r.name], ["Email", h("a", { href: mailto }, r.email)], ...cfg.fields(r), ["Received", fmtDate(r.created_at)], ["Status", badge(r.status === "new" ? "read" : r.status)]].map(([k, v]) => [
                h("dt", null, k),
                h("dd", null, v || "—"),
              ])
            ),
            h("label", null, "Notes", notes),
          ],
          [
            h(
              "div",
              { class: "actions" },
              h("a", { class: "btn btn-primary btn-sm", href: mailto }, "Reply by email"),
              h("button", { class: "btn btn-sm", onclick: () => update(r, { notes: notes.value }).then(() => toast("Notes saved")).catch(fail) }, "Save notes")
            ),
            h(
              "div",
              { class: "actions" },
              statusBtn("new", "Mark unread"),
              statusBtn("archived", "Archive"),
              h(
                "button",
                {
                  class: "btn btn-sm btn-danger",
                  onclick: async () => {
                    if (!confirm(`Delete this ${info.singular.toLowerCase()} permanently?`)) return;
                    try {
                      await api("DELETE", `/submissions/${type}/${r.id}`);
                      items = items.filter((x) => x !== r);
                      drawTable();
                      d.close();
                      refreshCounts();
                      toast("Deleted");
                    } catch (e) {
                      fail(e);
                    }
                  },
                },
                "Delete"
              )
            ),
          ]
        );
      }

      const tabBar = h(
        "div",
        { class: "tabs" },
        tabs.map(([value, label]) =>
          h("button", { class: state.status === value ? "active" : "", onclick: (e) => {
            state.status = value;
            tabBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
            load().catch(fail);
          } }, label)
        )
      );

      main.replaceChildren(
        pageHead(info.title, null, h("a", { class: "btn", href: `${API}/submissions/${type}/export.csv` }, "Export CSV")),
        h(
          "div",
          { class: "toolbar" },
          h("input", { type: "search", placeholder: "Search name, email or text…", value: state.q, oninput: (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
              state.q = e.target.value.trim();
              load().catch(fail);
            }, 250);
          } }),
          tabBar
        ),
        tableHolder
      );
      await load();
      if (openId) {
        const r = items.find((x) => x.id === Number(openId));
        if (r) openDetail(r);
      }
    };
  }

  /* ---------- Subscribers ---------- */

  async function subscribers() {
    const { items } = await api("GET", "/subscribers");
    const active = items.filter((s) => s.status === "active").length;
    main.replaceChildren(
      pageHead("Newsletter subscribers", `${active} active`, h("a", { class: "btn", href: `${API}/subscribers/export.csv` }, "Export CSV")),
      h(
        "div",
        { class: "table-wrap" },
        items.length
          ? h(
              "table",
              null,
              h("thead", null, h("tr", null, h("th", null, "Email"), h("th", null, "Signed up from"), h("th", null, "Date"), h("th", null, "Status"), h("th", null, ""))),
              h(
                "tbody",
                null,
                items.map((s) =>
                  h(
                    "tr",
                    null,
                    h("td", null, s.email),
                    h("td", { class: "muted" }, s.source || "—"),
                    h("td", { class: "muted" }, fmtDate(s.created_at)),
                    h("td", null, badge(s.status)),
                    h(
                      "td",
                      { style: "text-align:right" },
                      h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
                        if (!confirm(`Remove ${s.email}?`)) return;
                        await api("DELETE", `/subscribers/${s.id}`).then(subscribers).catch(fail);
                      } }, "Remove")
                    )
                  )
                )
              )
            )
          : emptyState("subscribers", "No subscribers yet", "People who sign up for the newsletter on the website appear here.")
      )
    );
  }

  /* ---------- Content (jobs, posts, projects) ---------- */

  function imageField(input) {
    const preview = h("img", { alt: "", src: siteUrl(input.value), hidden: !input.value });
    input.addEventListener("input", () => {
      preview.src = siteUrl(input.value);
      preview.hidden = !input.value;
    });
    const file = h("input", { type: "file", accept: "image/*", hidden: true, onchange: async () => {
      if (!file.files[0]) return;
      const fd = new FormData();
      fd.append("file", file.files[0]);
      try {
        const { url } = await api("POST", "/media", fd);
        input.value = url;
        input.dispatchEvent(new Event("input"));
        toast("Image uploaded");
      } catch (e) {
        fail(e);
      }
      file.value = "";
    } });
    return h("div", { class: "image-field" }, preview, h("div", { style: "flex:1;display:grid;gap:6px" }, input, h("div", null, h("button", { type: "button", class: "btn btn-sm", onclick: () => file.click() }, "Upload image"), file)));
  }

  // Mirrors videoSource() in server/src/util.js, for the live preview.
  function videoEmbed(value) {
    const v = String(value || "").trim();
    if (/^uploads\/videos\//.test(v)) return { type: "file", src: siteUrl(v) };
    let url;
    try {
      url = new URL(v);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^(www|m)\./, "");
    const ok = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null);
    let id = null;
    if (host === "youtu.be") id = ok(url.pathname.slice(1));
    else if (host === "youtube.com" || host === "youtube-nocookie.com") id = ok(url.searchParams.get("v")) || ok(url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1]);
    if (id) return { type: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const vimeo = url.pathname.match(/(?:^|\/)(\d{5,12})(?:\/|$)/)?.[1];
      if (vimeo) return { type: "vimeo", src: `https://player.vimeo.com/video/${vimeo}?dnt=1` };
    }
    return null;
  }

  // fetch() can't report upload progress, so large videos go through XHR.
  function uploadWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API + url);
      xhr.setRequestHeader("X-Requested-With", "magzest-admin");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 401) {
          sessionExpired();
          return reject(new Error("Your session expired — please sign in again."));
        }
        if (xhr.status >= 400 || data.ok === false) return reject(new Error(data.error || (xhr.status === 413 ? "That file is too large for the server." : "Upload failed.")));
        resolve(data);
      };
      xhr.onerror = () => reject(new Error("Upload failed — check your connection and try again."));
      const fd = new FormData();
      fd.append("file", file);
      xhr.send(fd);
    });
  }

  function videoField(input) {
    input.placeholder = "https://www.youtube.com/watch?v=…";
    const preview = h("div", { class: "video-preview", hidden: true });
    const bar = h("span");
    const pct = h("span", null, "0%");
    const progress = h("div", { hidden: true, style: "display:grid;gap:6px" }, h("div", { class: "progress-label" }, h("span", null, "Uploading…"), pct), h("div", { class: "progress" }, bar));

    function drawPreview() {
      const v = videoEmbed(input.value);
      preview.hidden = !v;
      if (!v) return preview.replaceChildren();
      preview.replaceChildren(
        v.type === "file"
          ? h("video", { src: v.src, controls: true, preload: "metadata" })
          : h("iframe", { src: v.src, title: "Video preview", allow: "encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true })
      );
    }
    let previewTimer;
    input.addEventListener("input", () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(drawPreview, 400);
    });

    async function upload(file) {
      if (!file) return;
      if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) return toast("Choose an MP4, WEBM or MOV video.", true);
      progress.hidden = false;
      drop.hidden = true;
      try {
        const { url } = await uploadWithProgress("/videos", file, (f) => {
          bar.style.width = Math.round(f * 100) + "%";
          pct.textContent = Math.round(f * 100) + "%";
        });
        input.value = url;
        drawPreview();
        toast("Video uploaded");
      } catch (e) {
        fail(e);
      }
      progress.hidden = true;
      drop.hidden = false;
      bar.style.width = "0";
    }

    const file = h("input", { type: "file", accept: "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v", hidden: true, onchange: () => (upload(file.files[0]), (file.value = "")) });
    const drop = h(
      "div",
      {
        class: "video-drop",
        role: "button",
        tabindex: "0",
        onclick: () => file.click(),
        onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), file.click()),
        ondragover: (e) => (e.preventDefault(), drop.classList.add("drag")),
        ondragleave: () => drop.classList.remove("drag"),
        ondrop: (e) => {
          e.preventDefault();
          drop.classList.remove("drag");
          upload(e.dataTransfer.files[0]);
        },
      },
      icon("upload"),
      h("b", null, "Upload a video"),
      h("span", null, "Drag a file here or click to choose · MP4, WEBM or MOV, up to 500 MB")
    );
    drawPreview();
    return h("div", { class: "video-field" }, drop, progress, file, h("div", { class: "video-or" }, "or paste a YouTube / Vimeo link"), input, preview);
  }

  function buildForm(fields, item) {
    const inputs = {};
    const grid = h(
      "div",
      { class: "form-grid" },
      fields.map((f) => {
        const value = item[f.key] ?? "";
        let input;
        if (f.type === "checkbox") {
          input = h("input", { type: "checkbox", checked: Boolean(value) });
          inputs[f.key] = input;
          return h("label", { class: "check" + (f.full ? " full" : "") }, input, f.label);
        }
        if (f.type === "select") input = h("select", null, f.options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
        else if (["textarea", "markdown", "code"].includes(f.type)) input = h("textarea", { class: f.type === "textarea" ? "" : f.type, rows: f.rows || 3, spellcheck: f.type !== "code" }, value);
        else if (f.type === "date") input = h("input", { type: "date", value: value ? String(value).slice(0, 10) : "" });
        else input = h("input", { type: f.type === "number" ? "number" : "text", value, placeholder: f.placeholder || "" });
        inputs[f.key] = input;
        const control = f.type === "image" ? imageField(input) : f.type === "video" ? videoField(input) : input;
        // The video field holds its own buttons, so it can't sit inside a <label>.
        return h(f.type === "video" ? "div" : "label", { class: (f.full ? "full" : "") + (f.type === "video" ? " field" : "") }, f.label, control, f.help && h("span", { class: "help" }, f.help));
      })
    );
    const values = () => {
      const out = {};
      for (const f of fields) {
        const el = inputs[f.key];
        out[f.key] = f.type === "checkbox" ? el.checked : f.type === "number" ? Number(el.value || 0) : el.value;
      }
      return out;
    };
    return { el: grid, inputs, values };
  }

  const CONTENT = {
    jobs: {
      title: "Job openings",
      subtitle: "Shown on the Careers page and in the application form's position list.",
      singular: "job",
      viewUrl: "/careers.html",
      defaults: { location: "Remote", employment_type: "Full-time", icon: "briefcase", is_open: 1 },
      label: (j) => j.title,
      columns: [
        ["Role", (j) => [h("div", { class: "name" }, j.title), h("div", { class: "sub" }, [j.location, j.employment_type, j.stack].filter(Boolean).join(" · "))]],
        ["Status", (j) => badge(j.is_open ? "open" : "closed")],
        ["Order", (j) => j.sort_order],
      ],
      fields: [
        { key: "title", label: "Job title", full: true },
        { key: "location", label: "Location", placeholder: "Remote / Hybrid / Hyderabad" },
        { key: "employment_type", label: "Type", placeholder: "Full-time / Internship" },
        { key: "stack", label: "Skills / stack", placeholder: "React / Tailwind" },
        { key: "icon", label: "Icon", help: "Any icon name from lucide.dev/icons, e.g. code, server, megaphone" },
        { key: "sort_order", label: "Display order", type: "number", help: "Lower numbers show first" },
        { key: "is_open", label: "Open — show on the website", type: "checkbox", full: true },
      ],
    },
    posts: {
      title: "Blog posts",
      subtitle: "Published posts get their own page at /blog/<slug>. “Coming soon” shows a teaser card only.",
      singular: "post",
      viewUrl: "/blog.html",
      defaults: { status: "draft" },
      label: (p) => p.title,
      columns: [
        ["", (p) => (p.cover_image ? h("img", { class: "thumb", src: siteUrl(p.cover_image), alt: "" }) : h("div", { class: "thumb" }))],
        ["Title", (p) => [h("div", { class: "name" }, p.title), h("div", { class: "sub" }, "/blog/" + p.slug)]],
        ["Category", (p) => p.category],
        ["Status", (p) => badge(p.status)],
        ["Published", (p) => h("span", { class: "muted" }, fmtDate(p.published_at, false))],
      ],
      fields: [
        { key: "title", label: "Title", full: true },
        { key: "slug", label: "URL slug", help: "magzest.tech/blog/<slug>" },
        { key: "category", label: "Category", placeholder: "Web Development" },
        { key: "status", label: "Status", type: "select", options: [["draft", "Draft (hidden)"], ["coming_soon", "Coming soon (teaser card)"], ["published", "Published"]] },
        { key: "published_at", label: "Publish date", type: "date", help: "Leave empty to use the day you publish" },
        { key: "excerpt", label: "Excerpt", type: "textarea", full: true, rows: 2, help: "One or two sentences for the blog card and search results" },
        { key: "cover_image", label: "Cover image", type: "image", full: true },
        { key: "body", label: "Article", type: "markdown", full: true, rows: 18, help: "Markdown: ## Heading, **bold**, *italic*, - list, [link](https://…), ![alt](uploads/image.jpg)" },
      ],
      extraActions: (item) => item.id && h("a", { class: "btn btn-sm", href: `/blog/${item.slug}?preview`, target: "_blank", rel: "noopener" }, "Preview ↗"),
    },
    projects: {
      title: "Portfolio",
      subtitle: "Project cards on the Portfolio page. Filter buttons are created from the categories automatically.",
      singular: "project",
      viewUrl: "/portfolio.html",
      defaults: { kind: "Web App", is_visible: 1 },
      label: (p) => p.title,
      columns: [
        ["", (p) => (p.image ? h("img", { class: "thumb", src: siteUrl(p.image), alt: "" }) : h("div", { class: "thumb", style: "display:grid;place-items:center;font-size:10px;color:#64748b" }, "mockup"))],
        ["Project", (p) => [h("div", { class: "name" }, p.title), h("div", { class: "sub truncate" }, p.description)]],
        ["Category", (p) => `${p.kind} · ${p.category_label}`],
        ["Status", (p) => badge(p.is_visible ? "published" : "hidden", p.is_visible ? "visible" : "hidden")],
        ["Order", (p) => p.sort_order],
      ],
      fields: [
        { key: "title", label: "Project name", full: true },
        { key: "category_label", label: "Category", placeholder: "EdTech", help: "Projects with the same category share a filter button" },
        { key: "kind", label: "Type", placeholder: "Web App / Mobile App / Desktop App" },
        { key: "description", label: "Short description", type: "textarea", full: true, rows: 2 },
        { key: "tags", label: "Tech tags", full: true, help: "Comma-separated, e.g. React, Node.js, MongoDB" },
        { key: "image", label: "Thumbnail image", type: "image", full: true, help: "If set, it replaces the mockup below" },
        { key: "mockup_html", label: "Mockup HTML (advanced)", type: "code", full: true, rows: 12, help: "The CSS dashboard mockup used when there's no image. Leave as is unless you know HTML/Tailwind." },
        { key: "sort_order", label: "Display order", type: "number" },
        { key: "is_visible", label: "Visible on the website", type: "checkbox" },
      ],
    },
  };

  CONTENT.vlogs = {
    title: "Vlogs",
    subtitle: "Videos on the Vlogs page. Upload a video file, or paste a YouTube or Vimeo link (best for long videos).",
    singular: "vlog",
    viewUrl: "/vlogs.html",
    defaults: { status: "draft" },
    label: (v) => v.title,
    emptyText: "Upload your first video: a project walkthrough, a day at Magzest or a quick tip.",
    columns: [
      ["", (v) => {
        const src = v.thumbnail ? siteUrl(v.thumbnail) : videoEmbed(v.video_url)?.thumb;
        return h("div", { class: "thumb-video", style: "width:72px" }, src ? h("img", { class: "thumb", src, alt: "" }) : h("div", { class: "thumb" }));
      }],
      ["Title", (v) => [h("div", { class: "name" }, v.title), h("div", { class: "sub" }, { file: "Uploaded video", youtube: "YouTube", vimeo: "Vimeo" }[videoEmbed(v.video_url)?.type] || "")]],
      ["Category", (v) => v.category || h("span", { class: "muted" }, "—")],
      ["Status", (v) => badge(v.status)],
      ["Published", (v) => h("span", { class: "muted" }, fmtDate(v.published_at, false))],
    ],
    fields: [
      { key: "title", label: "Title", full: true },
      { key: "video_url", label: "Video", type: "video", full: true },
      { key: "category", label: "Category", placeholder: "Behind the scenes" },
      { key: "status", label: "Status", type: "select", options: [["draft", "Draft (hidden)"], ["published", "Published"]] },
      { key: "description", label: "Description", type: "textarea", full: true, rows: 3, help: "A sentence or two shown under the video" },
      { key: "thumbnail", label: "Cover image (optional)", type: "image", full: true, help: "Shown before an uploaded video plays. YouTube videos use their own thumbnail." },
      { key: "published_at", label: "Publish date", type: "date", help: "Leave empty to use the day you publish" },
    ],
  };

  function contentView(kind) {
    const cfg = CONTENT[kind];
    return async function render(param) {
      const { items } = await api("GET", `/content/${kind}`);

      function edit(item) {
        const isNew = !item.id;
        const form = buildForm(cfg.fields, item);
        if (kind === "posts" && isNew) {
          let touched = false;
          form.inputs.slug.addEventListener("input", () => (touched = true));
          form.inputs.title.addEventListener("input", () => !touched && (form.inputs.slug.value = slugify(form.inputs.title.value)));
        }
        const save = h("button", { class: "btn btn-primary", onclick: async () => {
          save.disabled = true;
          try {
            await api(isNew ? "POST" : "PUT", isNew ? `/content/${kind}` : `/content/${kind}/${item.id}`, form.values());
            d.close();
            toast(isNew ? "Created — live on the website" : "Saved — live on the website");
            render();
          } catch (e) {
            fail(e);
            save.disabled = false;
          }
        } }, isNew ? `Create ${cfg.singular}` : "Save changes");
        const del =
          !isNew &&
          h("button", { class: "btn btn-danger", onclick: async () => {
            if (!confirm(`Delete “${cfg.label(item)}”? This can't be undone.`)) return;
            try {
              await api("DELETE", `/content/${kind}/${item.id}`);
              d.close();
              toast("Deleted");
              render();
            } catch (e) {
              fail(e);
            }
          } }, "Delete");
        const d = drawer(isNew ? `New ${cfg.singular}` : `Edit ${cfg.singular}`, form.el, [h("div", { class: "actions" }, save, cfg.extraActions && cfg.extraActions(item)), del || h("span")]);
        if (isNew) form.el.querySelector("input, textarea")?.focus();
      }

      main.replaceChildren(
        pageHead(cfg.title, cfg.subtitle, h("a", { class: "btn", href: cfg.viewUrl, target: "_blank", rel: "noopener" }, "View page", icon("external")), h("button", { class: "btn btn-primary", onclick: () => edit({ ...cfg.defaults }) }, icon("plus"), `New ${cfg.singular}`)),
        h(
          "div",
          { class: "table-wrap" },
          items.length
            ? h(
                "table",
                null,
                h("thead", null, h("tr", null, cfg.columns.map(([l]) => h("th", null, l)))),
                h("tbody", null, items.map((item) => h("tr", { class: "clickable", onclick: () => edit(item) }, cfg.columns.map(([, get]) => h("td", null, get(item))))))
              )
            : h(
                "div",
                null,
                emptyState({ posts: "blog", projects: "portfolio" }[kind] || kind, `No ${cfg.singular}s yet`, cfg.emptyText),
                h("div", { style: "display:flex;justify-content:center;padding:0 0 36px" }, h("button", { class: "btn btn-primary", onclick: () => edit({ ...cfg.defaults }) }, icon("plus"), `New ${cfg.singular}`))
              )
        )
      );
      // Dashboard shortcuts link to #/<route>/new.
      if (param === "new") {
        history.replaceState(null, "", location.hash.replace(/\/new$/, ""));
        edit({ ...cfg.defaults });
      }
    };
  }

  /* ---------- Media library ---------- */

  async function media() {
    const { items } = await api("GET", "/media");
    const file = h("input", { type: "file", accept: "image/*", hidden: true, onchange: async () => {
      if (!file.files[0]) return;
      const fd = new FormData();
      fd.append("file", file.files[0]);
      await api("POST", "/media", fd).then(() => (toast("Uploaded"), media())).catch(fail);
    } });
    main.replaceChildren(
      pageHead("Images", "Upload images to use in blog posts and portfolio cards. Copy the path into an image field or a post (![alt](path)).", h("button", { class: "btn btn-primary", onclick: () => file.click() }, "Upload image"), file),
      items.length
        ? h(
            "div",
            { class: "media-grid" },
            items.map((m) =>
              h(
                "div",
                { class: "media-item" },
                h("img", { src: siteUrl(m.url), alt: "", loading: "lazy" }),
                h(
                  "div",
                  null,
                  h("code", null, m.url),
                  h(
                    "div",
                    { class: "actions" },
                    h("button", { class: "btn btn-sm", onclick: () => navigator.clipboard.writeText(m.url).then(() => toast("Path copied")) }, "Copy path"),
                    h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
                      if (!confirm("Delete this image? Pages using it will show a broken image.")) return;
                      await api("DELETE", `/media/${encodeURIComponent(m.name)}`).then(media).catch(fail);
                    } }, "Delete")
                  )
                )
              )
            )
          )
        : h("div", { class: "card" }, emptyState("media", "No images uploaded yet", "Upload images to use as blog covers, vlog covers and portfolio thumbnails."))
    );
  }

  /* ---------- Settings ---------- */

  async function settings() {
    const [{ items: admins }, me] = await Promise.all([api("GET", "/admins"), api("GET", "/me")]);
    const mailBox = h("div", { class: "notice" }, "Checking email connection…");
    api("GET", "/mail-status")
      .then(({ mail: m }) => {
        mailBox.className = "notice" + (m.ok ? " ok" : "");
        mailBox.textContent = m.ok
          ? `Email is working. Notifications go to ${m.notifyTo}; auto-replies are ${m.autoReply ? "on" : "off"}.`
          : `Email is not sending: ${m.error}. Submissions are still saved here. Set the SMTP_* values in server/.env.`;
      })
      .catch(fail);

    const cur = h("input", { type: "password", autocomplete: "current-password" });
    const next = h("input", { type: "password", autocomplete: "new-password" });
    const newEmail = h("input", { type: "email", placeholder: "name@magzest.tech" });
    const newPass = h("input", { type: "password", autocomplete: "new-password", placeholder: "10+ characters" });

    main.replaceChildren(
      pageHead("Settings", `Signed in as ${me.admin.email}`),
      h(
        "div",
        { style: "display:grid;gap:20px;max-width:720px" },
        h("div", { class: "card" }, h("h2", null, "Email"), mailBox),
        h(
          "div",
          { class: "card", style: "display:grid;gap:14px" },
          h("h2", null, "Change password"),
          h("label", null, "Current password", cur),
          h("label", null, "New password", next, h("span", { class: "help" }, "At least 10 characters")),
          h("div", null, h("button", { class: "btn btn-primary", onclick: () =>
            api("POST", "/password", { current: cur.value, next: next.value })
              .then(() => {
                cur.value = next.value = "";
                toast("Password changed");
              })
              .catch(fail) }, "Update password"))
        ),
        h(
          "div",
          { class: "card", style: "display:grid;gap:14px" },
          h("h2", null, "Admin users"),
          h(
            "div",
            { class: "table-wrap" },
            h("table", null, h("tbody", null, admins.map((a) =>
              h("tr", null, h("td", null, a.email, a.id === me.admin.id && h("span", { class: "muted" }, " (you)")), h("td", { class: "muted" }, "Added " + fmtDate(a.created_at, false)),
                h("td", { style: "text-align:right" }, a.id !== me.admin.id && h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
                  if (!confirm(`Remove admin access for ${a.email}?`)) return;
                  await api("DELETE", `/admins/${a.id}`).then(settings).catch(fail);
                } }, "Remove"))
              ))))
          ),
          h("div", { class: "form-grid" }, h("label", null, "Email", newEmail), h("label", null, "Password", newPass)),
          h("div", null, h("button", { class: "btn", onclick: () =>
            api("POST", "/admins", { email: newEmail.value, password: newPass.value })
              .then(() => (toast("Admin added"), settings()))
              .catch(fail) }, "Add admin"))
        )
      )
    );
  }

  /* ---------- Router ---------- */

  const ROUTES = {
    dashboard: null, // set by ops.js
    messages: inbox("contact"),
    applications: inbox("application"),
    bookings: inbox("booking"),
    subscribers,
    jobs: contentView("jobs"),
    blog: contentView("posts"),
    portfolio: contentView("projects"),
    vlogs: contentView("vlogs"),
    media,
    settings,
  };

  // ops.js (pipeline, calendar, analytics) registers its routes through this.
  window.MzAdmin = { h, icon, api, toast, fail, fmtDate, badge, pageHead, drawer, main, siteUrl, refreshCounts, ROUTES, INBOX, TYPE_INFO, API };

  async function route() {
    const [name, param] = location.hash.replace(/^#\/?/, "").split("/");
    const key = ROUTES[name] ? name : "dashboard";
    document.querySelectorAll("#nav a[data-route]").forEach((a) => {
      const active = a.dataset.route === key;
      a.classList.toggle("active", active);
      if (active) {
        a.setAttribute("aria-current", "page");
        $("#crumb-title").textContent = a.querySelector("span").textContent;
        document.title = `${a.querySelector("span").textContent} · Magzest Admin`;
      } else a.removeAttribute("aria-current");
    });
    setMenu(false);
    document.querySelectorAll(".overlay").forEach((o) => o.remove());
    main.replaceChildren(h("div", { class: "skeleton", "aria-label": "Loading" }, h("div", { class: "sk-title" }), h("div", { class: "sk-row" }, h("div"), h("div"), h("div")), h("div", { class: "sk-block" })));
    try {
      await ROUTES[key](param);
    } catch (e) {
      main.replaceChildren(h("div", { class: "card" }, emptyState("alert", "This page couldn't load", e.message)));
    }
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", () => !$("#app-view").hidden && route());

  // The server signs admins out after a stretch with no requests. Writing a
  // long post makes none, so while someone is typing or clicking, check in
  // every few minutes to keep the session going.
  let lastActivity = Date.now();
  for (const type of ["keydown", "pointerdown", "input", "wheel"]) {
    document.addEventListener(type, () => (lastActivity = Date.now()), { capture: true, passive: true });
  }
  setInterval(() => {
    if ($("#app-view").hidden || Date.now() - lastActivity > 5 * 60 * 1000) return;
    fetch(API + "/me")
      .then((res) => res.status === 401 && sessionExpired())
      .catch(() => {});
  }, 4 * 60 * 1000);

  fetch(API + "/me")
    .then((res) => (res.ok ? showApp() : showLogin()))
    .catch(showLogin);
})();
