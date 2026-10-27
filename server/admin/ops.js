/* =========================================================
   Magzest Admin — pipelines, calendar, analytics, backups
   Loaded after admin.js; uses its helpers via window.MzAdmin
   and registers extra routes on its router.
   ========================================================= */

(function () {
  "use strict";

  const { h, icon, api, toast, fail, fmtDate, badge, pageHead, drawer, main, ROUTES, INBOX, API } = window.MzAdmin;

  /* ---------- Small helpers ---------- */

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
  const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const timeLabel = (t) => {
    const [hh, mm] = t.split(":").map(Number);
    return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
  };
  const dayLabel = (d, long) =>
    new Date(d + "T00:00:00").toLocaleDateString("en-IN", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" });
  const slotLabel = (slot) => (slot ? `${dayLabel(slot.slice(0, 10))}, ${timeLabel(slot.slice(11))} IST` : "—");
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  async function refreshPendingBookings() {
    try {
      const { items } = await api("GET", "/booking/upcoming");
      const n = items.filter((b) => b.booking_status === "pending").length;
      document.querySelectorAll('[data-count="pending-bookings"]').forEach((el) => (el.textContent = n ? String(n) : ""));
    } catch {}
  }

  /* ---------- Email templates for pipeline stages ---------- */

  const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
  const TEMPLATES = {
    application: {
      shortlisted: (r) => ({
        subject: `Your application for ${r.data.position} — next steps`,
        text: `Hi ${first(r.name)},\n\nThanks for applying for the ${r.data.position} role at Magzest. We enjoyed reading your application and would like to move you to the next stage.\n\nWe'll be in touch shortly to schedule a conversation. In the meantime, feel free to reply with any questions.\n\nBest regards,\nTeam Magzest`,
      }),
      interview: (r) => ({
        subject: `Interview invitation — ${r.data.position} at Magzest`,
        text: `Hi ${first(r.name)},\n\nWe'd like to invite you to an interview for the ${r.data.position} role.\n\nProposed time: [day, date] at [time] IST\nFormat: [video call link / office address]\nDuration: about 45 minutes\n\nPlease reply to confirm, or suggest a time that works better for you.\n\nBest regards,\nTeam Magzest`,
      }),
      offer: (r) => ({
        subject: `Offer from Magzest — ${r.data.position}`,
        text: `Hi ${first(r.name)},\n\nWe're delighted to offer you the ${r.data.position} role at Magzest!\n\nYour offer letter with the full details is attached / will follow separately. Please review it and let us know if you have any questions.\n\nWe're excited to have you on the team.\n\nBest regards,\nTeam Magzest`,
      }),
      rejected: (r) => ({
        subject: `Your application for ${r.data.position} at Magzest`,
        text: `Hi ${first(r.name)},\n\nThank you for your interest in the ${r.data.position} role and for the time you put into your application.\n\nAfter careful consideration, we've decided not to move forward with your application at this time. We'll keep your details on file and may reach out about future openings that match your profile.\n\nWe wish you all the best in your search.\n\nBest regards,\nTeam Magzest`,
      }),
    },
    lead: {
      contacted: (r) => ({
        subject: "Following up on your enquiry — Magzest",
        text: `Hi ${first(r.name)},\n\nThanks for getting in touch with Magzest${r.data.subject ? ` about ${r.data.subject}` : r.data.service ? ` about ${r.data.service}` : ""}. I'd love to understand your requirements in a bit more detail.\n\nWould you have 20 minutes for a quick call this week? Just reply with a time that suits you.\n\nBest regards,\nTeam Magzest`,
      }),
      proposal: (r) => ({
        subject: "Your proposal from Magzest",
        text: `Hi ${first(r.name)},\n\nAs discussed, please find our proposal for your project [attached / at this link].\n\nIt covers the scope, timeline and investment. Happy to walk you through it on a call — just let me know.\n\nBest regards,\nTeam Magzest`,
      }),
    },
  };
  const templateFor = (r, stage) => (TEMPLATES[r.type === "application" ? "application" : "lead"][stage] || null);

  /* ---------- Pipeline item drawer ---------- */

  function describe(r) {
    if (r.type === "application") return r.data.position || "Application";
    if (r.type === "booking") return `Call · ${r.data.service || ""}`;
    return r.data.subject || "Message";
  }

  function stars(value, onChange) {
    const wrap = h("div", { class: "stars", role: "radiogroup", "aria-label": "Rating" });
    const draw = (v) =>
      wrap.replaceChildren(
        ...[1, 2, 3, 4, 5].map((n) =>
          h("button", { type: "button", class: "star" + (n <= v ? " on" : ""), "aria-label": `${n} star${n > 1 ? "s" : ""}`, onclick: () => {
            const next = n === v ? 0 : n;
            onChange(next);
            draw((value = next));
          } }, "★")
        )
      );
    draw(value);
    return wrap;
  }

  function composer(r, preset, onSent) {
    const subject = h("input", { type: "text", value: preset?.subject || "" });
    const text = h("textarea", { rows: 10 }, preset?.text || "");
    const send = h("button", { class: "btn btn-primary btn-sm", onclick: async () => {
      send.disabled = true;
      try {
        await api("POST", `/pipeline/item/${r.id}/email`, { subject: subject.value, text: text.value });
        toast(`Email sent to ${r.email}`);
        onSent && onSent();
        box.remove();
      } catch (e) {
        fail(e);
        send.disabled = false;
      }
    } }, "Send email");
    const box = h(
      "div",
      { class: "card composer" },
      h("h2", null, `Email ${r.name}`),
      h("label", null, "Subject", subject),
      h("label", null, "Message", text, h("span", { class: "help" }, "Replace anything in [brackets] before sending.")),
      h("div", { class: "actions" }, send, h("button", { class: "btn btn-sm", onclick: () => box.remove() }, "Discard"))
    );
    return box;
  }

  async function openItem(r, stages, onChange) {
    const isHiring = r.type === "application";
    const timeline = h("div", { class: "timeline" });
    const composeSlot = h("div");

    async function loadTimeline() {
      const { items } = await api("GET", `/pipeline/item/${r.id}/activity`);
      timeline.replaceChildren(
        ...(items.length
          ? items.map((a) => h("div", { class: `tl tl-${a.kind}` }, h("div", { class: "tl-text" }, a.text), h("div", { class: "tl-meta" }, `${fmtDate(a.created_at)}${a.admin_email ? " · " + a.admin_email : ""}`)))
          : [h("p", { class: "muted" }, "No activity yet.")]),
        h("div", { class: "tl tl-created" }, h("div", { class: "tl-text" }, `${isHiring ? "Applied" : "Enquiry received"} via the website`), h("div", { class: "tl-meta" }, fmtDate(r.created_at)))
      );
    }

    async function save(patch) {
      try {
        const { item } = await api("PATCH", `/pipeline/item/${r.id}`, patch);
        Object.assign(r, item, { data: r.data });
        onChange && onChange(r);
        loadTimeline();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    }

    const stageSelect = h(
      "select",
      { onchange: async () => {
        const stage = stageSelect.value;
        if (!(await save({ stage }))) return;
        toast(`Moved to ${cap(stage)}`);
        const tpl = templateFor(r, stage);
        if (tpl) composeSlot.replaceChildren(composer(r, tpl(r), loadTimeline));
      } },
      stages.map((s) => h("option", { value: s, selected: s === r.stage }, cap(s)))
    );
    const followUp = h("input", { type: "date", value: r.follow_up || "", onchange: () => save({ follow_up: followUp.value }).then((ok) => ok && toast("Follow-up saved")) });
    const value = h("input", { type: "number", min: 0, step: 1000, value: r.deal_value || 0, onchange: () => save({ deal_value: Number(value.value) }).then((ok) => ok && toast("Deal value saved")) });
    const note = h("textarea", { rows: 2, placeholder: "Add a note — call summary, feedback, next step…" });

    const cfg = INBOX[r.type];
    const details = h(
      "dl",
      { class: "fields" },
      [["Email", h("a", { href: `mailto:${r.email}` }, r.email)], ...cfg.fields(r), ["Received", fmtDate(r.created_at)]].map(([k, v]) => [h("dt", null, k), h("dd", null, v || "—")])
    );

    drawer(
      `${r.name} — ${describe(r)}`,
      [
        h(
          "div",
          { class: "form-grid" },
          h("label", null, "Stage", stageSelect),
          h("label", null, "Follow up on", followUp),
          isHiring ? h("label", null, "Rating", stars(r.rating, (n) => save({ rating: n }))) : h("label", null, "Deal value (₹)", value)
        ),
        details,
        h(
          "div",
          { class: "actions" },
          h("button", { class: "btn btn-primary btn-sm", onclick: () => {
            const tpl = templateFor(r, r.stage);
            composeSlot.replaceChildren(composer(r, tpl ? tpl(r) : { subject: "", text: `Hi ${first(r.name)},\n\n\n\nBest regards,\nTeam Magzest` }, loadTimeline));
          } }, "Write email"),
          r.has_file && h("a", { class: "btn btn-sm", href: `${API}/submissions/application/${r.id}/resume` }, "Download resume"),
          r.type === "booking" && h("a", { class: "btn btn-sm", href: "#/calendar" }, "Open calendar")
        ),
        composeSlot,
        h(
          "div",
          { class: "card", style: "display:grid;gap:10px" },
          h("h2", { style: "margin:0" }, "Activity"),
          note,
          h("div", null, h("button", { class: "btn btn-sm", onclick: async () => {
            try {
              await api("POST", `/pipeline/item/${r.id}/notes`, { text: note.value });
              note.value = "";
              loadTimeline();
            } catch (e) {
              fail(e);
            }
          } }, "Add note")),
          timeline
        ),
      ],
      null
    );
    loadTimeline().catch(fail);
    if (r.status === "new") api("PATCH", `/submissions/${r.type}/${r.id}`, { status: "read" }).then(() => (r.status = "read")).catch(() => {});
  }

  /* ---------- Pipeline board (hiring + leads) ---------- */

  const BOARDS = {
    hiring: { title: "Hiring pipeline", subtitle: "Drag candidates between stages. Moving to a stage offers a ready-made email.", empty: "No applications yet." },
    leads: { title: "Leads (CRM)", subtitle: "Contact messages and call bookings. Track stage, deal value and follow-ups.", empty: "No leads yet." },
  };

  function pipelineView(board) {
    const cfg = BOARDS[board];
    const state = { view: localStorage.getItem(`mz-${board}-view`) || "board", q: "", archived: false };

    return async function render(openId) {
      const holder = h("div");
      let stages = [];
      let items = [];

      async function load() {
        const data = await api("GET", `/pipeline/${board}${state.archived ? "?archived=1" : ""}`);
        stages = data.stages;
        items = data.items;
        draw();
      }

      const visible = () => {
        const q = state.q.toLowerCase();
        return q ? items.filter((r) => [r.name, r.email, describe(r)].join(" ").toLowerCase().includes(q)) : items;
      };

      async function move(r, stage) {
        if (r.stage === stage) return;
        try {
          await api("PATCH", `/pipeline/item/${r.id}`, { stage });
          r.stage = stage;
          draw();
          const tpl = templateFor(r, stage);
          toast(`${r.name} → ${cap(stage)}${tpl ? " (open the card to send the email)" : ""}`);
        } catch (e) {
          fail(e);
        }
      }

      function cardFor(r) {
        const overdue = r.follow_up && r.follow_up <= todayIST();
        return h(
          "div",
          {
            class: "pcard" + (r.status === "new" ? " unread" : ""),
            draggable: "true",
            tabindex: "0",
            ondragstart: (e) => {
              e.dataTransfer.setData("text/plain", String(r.id));
              e.currentTarget.classList.add("dragging");
            },
            ondragend: (e) => e.currentTarget.classList.remove("dragging"),
            onclick: () => openItem(r, stages, draw),
            onkeydown: (e) => e.key === "Enter" && openItem(r, stages, draw),
          },
          h("div", { class: "name" }, r.name),
          h("div", { class: "sub" }, describe(r)),
          h(
            "div",
            { class: "pcard-meta" },
            board === "hiring" ? (r.rating ? h("span", { class: "rating" }, "★".repeat(r.rating)) : null) : r.deal_value ? h("span", { class: "value" }, rupees(r.deal_value)) : null,
            r.follow_up ? h("span", { class: "due" + (overdue ? " overdue" : "") }, `⏰ ${fmtDate(r.follow_up + "T00:00", false)}`) : null,
            r.has_file ? h("span", { title: "Resume attached" }, "📎") : null,
            h("span", { class: "age" }, fmtDate(r.created_at, false))
          )
        );
      }

      function draw() {
        const list = visible();
        if (!items.length) return holder.replaceChildren(h("div", { class: "card empty" }, cfg.empty));
        if (state.view === "board") {
          holder.replaceChildren(
            h(
              "div",
              { class: "board" },
              stages.map((stage) => {
                const col = list.filter((r) => r.stage === stage);
                const total = col.reduce((s, r) => s + (r.deal_value || 0), 0);
                return h(
                  "div",
                  {
                    class: `column col-${stage}`,
                    ondragover: (e) => {
                      e.preventDefault();
                      e.currentTarget.classList.add("drop");
                    },
                    ondragleave: (e) => e.currentTarget.classList.remove("drop"),
                    ondrop: (e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("drop");
                      const r = items.find((x) => x.id === Number(e.dataTransfer.getData("text/plain")));
                      if (r) move(r, stage);
                    },
                  },
                  h("div", { class: "column-head" }, h("span", null, cap(stage)), h("span", { class: "count" }, col.length), board === "leads" && total ? h("span", { class: "total" }, rupees(total)) : null),
                  h("div", { class: "column-body" }, col.map(cardFor))
                );
              })
            )
          );
        } else {
          holder.replaceChildren(
            h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                null,
                h("thead", null, h("tr", null, ["Name", board === "hiring" ? "Position" : "Enquiry", "Stage", board === "hiring" ? "Rating" : "Value", "Follow up", "Received"].map((t) => h("th", null, t)))),
                h(
                  "tbody",
                  null,
                  list.map((r) =>
                    h(
                      "tr",
                      { class: "clickable" + (r.status === "new" ? " unread" : ""), onclick: (e) => e.target.tagName !== "SELECT" && openItem(r, stages, draw) },
                      h("td", null, h("div", { class: "name" }, r.name), h("div", { class: "sub" }, r.email)),
                      h("td", null, describe(r)),
                      h("td", null, h("select", { class: "inline-select", onchange: (e) => move(r, e.target.value) }, stages.map((s) => h("option", { value: s, selected: s === r.stage }, cap(s))))),
                      h("td", null, board === "hiring" ? (r.rating ? "★".repeat(r.rating) : "—") : r.deal_value ? rupees(r.deal_value) : "—"),
                      h("td", { class: r.follow_up && r.follow_up <= todayIST() ? "overdue-text" : "muted" }, r.follow_up ? fmtDate(r.follow_up + "T00:00", false) : "—"),
                      h("td", { class: "muted" }, fmtDate(r.created_at, false))
                    )
                  )
                )
              )
            )
          );
        }
      }

      const viewTabs = h(
        "div",
        { class: "tabs" },
        [["board", "Board"], ["list", "List"]].map(([v, l]) =>
          h("button", { class: state.view === v ? "active" : "", onclick: (e) => {
            state.view = v;
            try {
              localStorage.setItem(`mz-${board}-view`, v);
            } catch {}
            viewTabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
            draw();
          } }, l)
        )
      );

      main.replaceChildren(
        pageHead(cfg.title, cfg.subtitle),
        h(
          "div",
          { class: "toolbar" },
          h("input", { type: "search", placeholder: "Search…", oninput: (e) => {
            state.q = e.target.value.trim();
            draw();
          } }),
          viewTabs,
          h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => {
            state.archived = e.target.checked;
            load().catch(fail);
          } }), "Include archived")
        ),
        holder
      );
      await load();
      if (openId) {
        const r = items.find((x) => x.id === Number(openId));
        if (r) openItem(r, stages, draw);
      }
    };
  }

  /* ---------- Call calendar ---------- */

  // Public availability endpoint: the slots a visitor could book right now.
  async function slotPicker() {
    const avail = await fetch("/api/booking/availability", { cache: "no-store" }).then((r) => r.json());
    const dateSel = h("select", null, h("option", { value: "" }, "Choose a day"), avail.days.map((d) => h("option", { value: d.date }, `${dayLabel(d.date)} · ${d.slots.length} open`)));
    const timeSel = h("select", { disabled: true }, h("option", { value: "" }, "Time"));
    dateSel.addEventListener("change", () => {
      const day = avail.days.find((d) => d.date === dateSel.value);
      timeSel.replaceChildren(h("option", { value: "" }, "Time"), ...(day ? day.slots.map((t) => h("option", { value: t }, timeLabel(t))) : []));
      timeSel.disabled = !day;
    });
    return { el: h("div", { class: "form-grid" }, h("label", null, "New day", dateSel), h("label", null, "New time (IST)", timeSel)), value: () => ({ date: dateSel.value, time: timeSel.value }) };
  }

  function bookingAction(title, body, button, run) {
    const message = h("textarea", { rows: 3, placeholder: "Optional personal note to include in the email" });
    const go = h("button", { class: "btn btn-primary", onclick: async () => {
      go.disabled = true;
      try {
        const res = await run(message.value);
        d.close();
        toast(res.emailed ? `${button} — client emailed` : `${button} — email not sent${res.emailError ? ` (${res.emailError})` : ""}`, !res.emailed && res.emailError && !/not confirmed/.test(res.emailError));
        calendar();
        refreshPendingBookings();
      } catch (e) {
        fail(e);
        go.disabled = false;
      }
    } }, button);
    const d = drawer(title, [body, h("label", null, "Message", message)], [go, h("span")]);
  }

  async function calendar(param) {
    if (param === "settings") return bookingSettings();
    const { items } = await api("GET", "/booking/upcoming");
    const byDay = new Map();
    for (const b of items) {
      const day = b.slot.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(b);
    }
    const pending = items.filter((b) => b.booking_status === "pending").length;

    const row = (b) =>
      h(
        "div",
        { class: `booking-row status-${b.booking_status}` },
        h("div", { class: "booking-time" }, timeLabel(b.slot.slice(11))),
        h(
          "div",
          { class: "booking-info" },
          h("div", { class: "name" }, b.name, " ", badge(b.booking_status)),
          h("div", { class: "sub" }, `${b.data.service || "Consultation"} · ${b.email}`),
          b.meeting_link ? h("a", { class: "sub", href: b.meeting_link, target: "_blank", rel: "noopener" }, b.meeting_link) : null
        ),
        h(
          "div",
          { class: "actions" },
          b.booking_status === "pending" &&
            h("button", { class: "btn btn-primary btn-sm", onclick: async () => {
              const settings = (await api("GET", "/booking/settings")).settings;
              const link = h("input", { type: "text", value: b.meeting_link || settings.meetingLink || "", placeholder: "https://meet.google.com/… or Teams link" });
              bookingAction(
                `Confirm call with ${b.name}`,
                [h("p", { class: "muted", style: "margin:0" }, `${slotLabel(b.slot)} · ${b.data.service || ""}`), h("label", null, "Meeting link", link, h("span", { class: "help" }, "Leave empty if you'll phone them. The client gets an email with a calendar invite."))],
                "Confirm",
                (message) => api("POST", `/booking/${b.id}/confirm`, { meeting_link: link.value.trim(), message })
              );
            } }, "Confirm"),
          h("button", { class: "btn btn-sm", onclick: async () => {
            try {
              const picker = await slotPicker();
              bookingAction(`Reschedule ${b.name}`, [h("p", { class: "muted", style: "margin:0" }, `Currently ${slotLabel(b.slot)}`), picker.el], "Reschedule", (message) => {
                const v = picker.value();
                if (!v.date || !v.time) return Promise.reject(new Error("Pick a new day and time."));
                return api("POST", `/booking/${b.id}/reschedule`, { ...v, message });
              });
            } catch (e) {
              fail(e);
            }
          } }, "Reschedule"),
          h("a", { class: "btn btn-sm", href: `${API}/booking/${b.id}/invite.ics`, title: "Add to your own calendar" }, ".ics"),
          h("button", { class: "btn btn-sm btn-danger", onclick: () =>
            bookingAction(`Cancel call with ${b.name}?`, h("p", { class: "muted", style: "margin:0" }, `${slotLabel(b.slot)}. The slot becomes free for others to book.`), "Cancel call", (message) =>
              api("POST", `/booking/${b.id}/cancel`, { message })
            ) }, "Cancel"),
          h("a", { class: "btn btn-sm", href: `#/leads/${b.id}` }, "Lead")
        )
      );

    main.replaceChildren(
      pageHead("Call calendar", pending ? `${pending} booking${pending > 1 ? "s" : ""} waiting for confirmation.` : "Upcoming consultation calls (IST).", h("a", { class: "btn", href: "#/calendar/settings" }, "Availability settings")),
      byDay.size
        ? h(
            "div",
            { class: "agenda" },
            [...byDay].map(([day, list]) => h("div", { class: "agenda-day" }, h("h2", null, day === todayIST() ? `Today · ${dayLabel(day, true)}` : dayLabel(day, true)), h("div", { class: "card agenda-list" }, list.map(row))))
          )
        : h("div", { class: "card empty" }, "No upcoming calls. Bookings from the website's “Request a Consultation” button appear here.")
    );
  }

  async function bookingSettings() {
    const { settings: s } = await api("GET", "/booking/settings");
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const order = [1, 2, 3, 4, 5, 6, 0];
    const dayRows = {};
    const slot = h("select", null, [15, 20, 30, 45, 60, 90].map((m) => h("option", { value: m, selected: m === s.slotMinutes }, `${m} minutes`)));
    const notice = h("input", { type: "number", min: 0, max: 168, value: s.minNoticeHours });
    const ahead = h("input", { type: "number", min: 1, max: 90, value: s.maxDaysAhead });
    const link = h("input", { type: "text", value: s.meetingLink, placeholder: "https://teams.microsoft.com/… (optional)" });
    let blocked = [...s.blockedDates];
    const blockedList = h("div", { class: "chips" });
    const drawBlocked = () =>
      blockedList.replaceChildren(
        ...(blocked.length
          ? blocked.map((d) => h("span", { class: "chip" }, dayLabel(d), h("button", { type: "button", "aria-label": "Remove", onclick: () => ((blocked = blocked.filter((x) => x !== d)), drawBlocked()) }, "×")))
          : [h("span", { class: "muted" }, "No blocked dates.")])
      );
    drawBlocked();
    const newBlocked = h("input", { type: "date", min: todayIST() });

    main.replaceChildren(
      pageHead("Availability settings", "Controls which slots visitors can pick in the booking form. All times are IST.", h("a", { class: "btn", href: "#/calendar" }, "← Back to calendar")),
      h(
        "div",
        { style: "display:grid;gap:20px;max-width:760px" },
        h(
          "div",
          { class: "card", style: "display:grid;gap:12px" },
          h("h2", null, "Working hours"),
          order.map((d) => {
            const open = h("input", { type: "checkbox", checked: Boolean(s.hours[d]) });
            const from = h("input", { type: "time", value: s.hours[d]?.[0] || "10:00", step: 900 });
            const to = h("input", { type: "time", value: s.hours[d]?.[1] || "18:00", step: 900 });
            const sync = () => (from.disabled = to.disabled = !open.checked);
            open.addEventListener("change", sync);
            sync();
            dayRows[d] = { open, from, to };
            return h("div", { class: "hours-row" }, h("label", { class: "check" }, open, DAYS[d]), from, h("span", { class: "muted" }, "to"), to);
          })
        ),
        h(
          "div",
          { class: "card form-grid" },
          h("label", null, "Call length", slot),
          h("label", null, "Minimum notice (hours)", notice, h("span", { class: "help" }, "How soon a visitor can book")),
          h("label", null, "Bookable days ahead", ahead),
          h("label", null, "Default meeting link", link, h("span", { class: "help" }, "Pre-filled when you confirm a call"))
        ),
        h(
          "div",
          { class: "card", style: "display:grid;gap:12px" },
          h("h2", null, "Blocked dates"),
          h("p", { class: "muted", style: "margin:0" }, "Holidays and days off — no slots are offered on these dates."),
          blockedList,
          h("div", { class: "actions" }, newBlocked, h("button", { type: "button", class: "btn btn-sm", onclick: () => {
            if (newBlocked.value && !blocked.includes(newBlocked.value)) blocked = [...blocked, newBlocked.value].sort();
            newBlocked.value = "";
            drawBlocked();
          } }, "Block date"))
        ),
        h("div", null, h("button", { class: "btn btn-primary", onclick: async () => {
          const hours = {};
          for (const d of order) hours[d] = dayRows[d].open.checked ? [dayRows[d].from.value, dayRows[d].to.value] : null;
          for (const d of order) {
            if (hours[d] && !(hours[d][0] < hours[d][1])) return toast(`${DAYS[d]}: closing time must be after opening time.`, true);
          }
          try {
            await api("PUT", "/booking/settings", { hours, slotMinutes: Number(slot.value), minNoticeHours: Number(notice.value), maxDaysAhead: Number(ahead.value), blockedDates: blocked, meetingLink: link.value.trim() });
            toast("Availability saved — live on the website");
          } catch (e) {
            fail(e);
          }
        } }, "Save availability"))
      )
    );
  }

  /* ---------- Analytics ---------- */

  function change(cur, prev) {
    if (!prev) return cur ? h("span", { class: "delta up" }, "new") : null;
    const pct = Math.round(((cur - prev) / prev) * 100);
    return h("span", { class: "delta " + (pct >= 0 ? "up" : "down") }, `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}%`);
  }

  function chart(daily) {
    const W = 760, H = 200, P = { l: 34, r: 8, t: 10, b: 24 };
    const max = Math.max(4, ...daily.map((d) => Math.max(d.views, d.visitors)));
    const step = (W - P.l - P.r) / daily.length;
    const y = (v) => P.t + (H - P.t - P.b) * (1 - v / max);
    const ticks = [0, Math.round(max / 2), max];
    const labelEvery = Math.ceil(daily.length / 8);
    return svg(
      "svg",
      { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Daily visitors and page views" },
      ticks.map((t) => [svg("line", { x1: P.l, x2: W - P.r, y1: y(t), y2: y(t), class: "grid" }), svg("text", { x: P.l - 6, y: y(t) + 4, class: "axis", "text-anchor": "end" }, t)]),
      daily.map((d, i) => {
        const x = P.l + i * step;
        const bw = Math.max(2, step * 0.7);
        return svg(
          "g",
          null,
          svg("rect", { x: x + (step - bw) / 2, y: y(d.views), width: bw, height: H - P.b - y(d.views), class: "bar-views" }),
          svg("rect", { x: x + (step - bw) / 2, y: y(d.visitors), width: bw, height: H - P.b - y(d.visitors), class: "bar-visitors" }),
          d.submissions ? svg("circle", { cx: x + step / 2, cy: y(d.visitors) - 6, r: 3, class: "dot-conv" }) : null,
          svg("title", null, `${d.day}: ${d.visitors} visitors, ${d.views} views, ${d.submissions} submissions`),
          i % labelEvery === 0 ? svg("text", { x: x + step / 2, y: H - 6, class: "axis", "text-anchor": "middle" }, new Date(d.day + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })) : null
        );
      })
    );
  }

  let analyticsDays = 30;
  async function analytics() {
    const a = await api("GET", `/analytics?days=${analyticsDays}`);
    const c = a.current, p = a.previous;
    const rate = (x) => (x.visitors ? ((x.submissions / x.visitors) * 100).toFixed(1) + "%" : "—");
    const kpi = (label, value, delta, sub) => h("div", { class: "card stat" }, h("div", { class: "label" }, label), h("div", { class: "num" }, value, " ", delta), h("div", { class: "sub" }, sub));
    const TYPE_LABEL = { contact: "Contact messages", application: "Job applications", booking: "Call bookings" };
    const tabs = h(
      "div",
      { class: "tabs" },
      [7, 30, 90].map((d) => h("button", { class: d === analyticsDays ? "active" : "", onclick: () => ((analyticsDays = d), analytics().catch(fail)) }, `${d} days`))
    );
    const table = (head, rows) =>
      h("div", { class: "table-wrap" }, rows.length ? h("table", null, h("thead", null, h("tr", null, head.map((t) => h("th", null, t)))), h("tbody", null, rows)) : h("div", { class: "empty" }, "No data yet."));

    main.replaceChildren(
      pageHead("Analytics", "Cookie-free and private: no tracking scripts, no personal data stored. Your own admin visits aren't counted.", tabs),
      h(
        "div",
        { class: "stats" },
        kpi("Visitors", c.visitors.toLocaleString("en-IN"), change(c.visitors, p.visitors), "unique per day"),
        kpi("Page views", c.views.toLocaleString("en-IN"), change(c.views, p.views), `${c.visitors ? (c.views / c.visitors).toFixed(1) : 0} pages per visitor`),
        kpi("Form submissions", c.submissions, change(c.submissions, p.submissions), `+ ${c.subscribers} newsletter sign-ups`),
        kpi("Conversion rate", rate(c), null, `previous period: ${rate(p)}`)
      ),
      h("div", { class: "card", style: "margin-bottom:20px" }, h("div", { class: "legend" }, h("span", { class: "lg-visitors" }, "Visitors"), h("span", { class: "lg-views" }, "Page views"), h("span", { class: "lg-conv" }, "Day with a submission")), chart(a.daily)),
      h(
        "div",
        { class: "grid-3" },
        h("div", null, h("h2", null, "Top pages"), table(["Page", "Views"], a.pages.map((r) => h("tr", null, h("td", null, h("a", { href: r.path, target: "_blank", rel: "noopener" }, r.path)), h("td", null, r.views))))),
        h("div", null, h("h2", null, "Where visitors came from"), table(["Source", "Visits"], a.sources.map((r) => h("tr", null, h("td", null, r.source), h("td", null, r.visits))))),
        h("div", null, h("h2", null, "Conversions"), table(["Form", "Count"], a.conversions.map((r) => h("tr", null, h("td", null, TYPE_LABEL[r.type] || r.type), h("td", null, r.n)))))
      )
    );
  }

  /* ---------- Dashboard: what needs doing today ---------- */

  // "srilatha@magzest.in" → "Srilatha". Shared inboxes get no name.
  function firstNameFromEmail(email) {
    const local = String(email || "").split("@")[0].split(/[._-]/)[0];
    if (!/^[a-z]{2,}$/i.test(local) || /^(admin|contact|info|hello|team|office|sales|hr|support|mail)$/i.test(local)) return "";
    return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
  }

  function timeAgo(iso) {
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `${hrs} h ago`;
    const days = Math.round(hrs / 24);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }

  // Current IST time as "YYYY-MM-DD HH:MM", comparable with booking slots.
  const nowSlotIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace("T", " ");

  // "Today", "Tomorrow" or "Wed, 28 Oct" for a YYYY-MM-DD date.
  function relativeDay(date, today) {
    const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
    return date === today ? "Today" : date === tomorrow ? "Tomorrow" : dayLabel(date);
  }

  // Small counts read better as "+2" than "▲ 200%".
  function trend(cur, prev) {
    if (cur === prev) return h("span", { class: "delta flat" }, "same");
    if (prev >= 10 && cur >= 10) return change(cur, prev);
    const diff = cur - prev;
    return h("span", { class: "delta " + (diff > 0 ? "up" : "down") }, `${diff > 0 ? "+" : "−"}${Math.abs(diff)}`);
  }

  function sparkline(values, label) {
    const W = 112, H = 32, pad = 2;
    const max = Math.max(1, ...values);
    const step = (W - pad * 2) / Math.max(1, values.length - 1);
    const pts = values.map((v, i) => [pad + i * step, H - pad - (v / max) * (H - pad * 2)]);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const last = pts.at(-1);
    return svg(
      "svg",
      { class: "spark", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": label },
      svg("path", { d: `${line} L${last[0]},${H} L${pad},${H} Z`, class: "spark-area" }),
      svg("path", { d: line, class: "spark-line" }),
      svg("circle", { cx: last[0], cy: last[1], r: 2.5, class: "spark-dot" })
    );
  }

  // One sentence summing up the day, written from the data.
  function brief(d) {
    const parts = [];
    const n = d.attention.length;
    const urgent = d.attention.filter((a) => a.tone === "red").length;
    parts.push(n ? `${n} thing${n === 1 ? " needs" : "s need"} your attention${urgent ? `, ${urgent} of them urgent` : ""}.` : "Nothing needs you right now.");
    const now = nowSlotIST();
    const calls = d.upcoming.filter((b) => b.slot >= now);
    const today = calls.filter((b) => b.slot.startsWith(d.today));
    if (today.length) parts.push(`${today.length === 1 ? "One call" : `${today.length} calls`} today, the next at ${timeLabel(today[0].slot.slice(11))}.`);
    else if (calls.length) {
      const next = calls[0];
      parts.push(`Next call: ${relativeDay(next.slot.slice(0, 10), d.today).replace(/^T/, "t")} at ${timeLabel(next.slot.slice(11))} with ${first(next.name)}.`);
    }
    const v = d.week.visitors;
    if (v.previous >= 10) {
      const pct = Math.round(((v.current - v.previous) / v.previous) * 100);
      parts.push(Math.abs(pct) < 5 ? "Website traffic is steady." : `Website visitors are ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on last week.`);
    } else if (v.current) parts.push(`${v.current} visitors this week.`);
    return parts.join(" ");
  }

  const KIND_ICON = { lead: "leads", hiring: "hiring", booking: "calendar", "follow-up": "messages", system: "settings" };

  function attentionList(items) {
    if (!items.length) {
      return h("div", { class: "all-clear" }, icon("check"), h("b", null, "You're all caught up"), h("span", null, "New enquiries, calls to confirm and follow-ups will show up here."));
    }
    return h(
      "ul",
      { class: "todo" },
      items.map((a) =>
        h(
          "li",
          null,
          h(
            "a",
            { class: `todo-row tone-${a.tone}`, href: a.href },
            h("span", { class: "todo-icon" }, icon(KIND_ICON[a.kind] || "alert")),
            h("span", { class: "todo-text" }, h("b", null, a.title), h("span", null, a.detail)),
            h("span", { class: "todo-meta" }, a.at ? timeAgo(a.at) : a.tone === "red" ? "Urgent" : "")
          )
        )
      )
    );
  }

  function weekCard(w) {
    const row = (label, metric, spark) =>
      h(
        "div",
        { class: "wk-row" },
        h("span", { class: "wk-label" }, label),
        spark || h("span"),
        h("span", { class: "wk-num" }, metric.current.toLocaleString("en-IN")),
        trend(metric.current, metric.previous)
      );
    return h(
      "section",
      { class: "card dash-card" },
      h("header", { class: "dash-card-head" }, h("h2", null, "This week"), h("span", { class: "muted" }, "vs the 7 days before")),
      row("Visitors", w.visitors, sparkline(w.daily.map((d) => d.visitors), "Visitors per day, last 7 days")),
      row("Page views", w.views, sparkline(w.daily.map((d) => d.views), "Page views per day, last 7 days")),
      row("Enquiries", w.enquiries),
      row("Applications", w.applications),
      row("Newsletter sign-ups", w.subscribers),
      h("a", { class: "dash-card-link", href: "#/analytics" }, "Full analytics →")
    );
  }

  function pipelineCard(stages, wonThisMonth) {
    const LEAD = ["new", "contacted", "proposal", "won", "lost"];
    const total = LEAD.reduce((t, st) => t + stages[st].count, 0);
    const open = ["new", "contacted", "proposal"].reduce((t, st) => t + stages[st].value, 0);
    return h(
      "section",
      { class: "card dash-card" },
      h("header", { class: "dash-card-head" }, h("h2", null, "Sales pipeline"), h("a", { href: "#/leads" }, "Open board →")),
      total
        ? h(
            "div",
            { class: "funnel", role: "img", "aria-label": LEAD.map((st) => `${stages[st].count} ${st}`).join(", ") },
            LEAD.filter((st) => stages[st].count).map((st) => h("span", { class: `seg seg-${st}`, style: `flex-grow:${stages[st].count}`, title: `${cap(st)}: ${stages[st].count}` }))
          )
        : null,
      h(
        "div",
        { class: "stage-list" },
        LEAD.map((st) =>
          h("div", { class: "stage" }, h("i", { class: `dot seg-${st}` }), h("span", null, cap(st)), h("b", null, stages[st].count), h("span", { class: "muted" }, stages[st].value ? rupees(stages[st].value) : ""))
        )
      ),
      h("div", { class: "dash-card-foot" }, h("span", null, "Open ", h("b", null, rupees(open))), h("span", null, "Won this month ", h("b", null, rupees(wonThisMonth))))
    );
  }

  function agendaCard(upcoming, today) {
    const now = nowSlotIST();
    const calls = upcoming.filter((b) => b.slot >= now).slice(0, 6);
    const groups = new Map();
    for (const b of calls) {
      const d = b.slot.slice(0, 10);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(b);
    }
    return h(
      "section",
      { class: "card dash-card" },
      h("header", { class: "dash-card-head" }, h("h2", null, "Coming up"), h("a", { href: "#/calendar" }, "Calendar →")),
      calls.length
        ? [...groups].map(([d, list]) =>
            h(
              "div",
              { class: "agenda-day" },
              h("div", { class: "agenda-date" }, relativeDay(d, today)),
              list.map((b) =>
                h(
                  "a",
                  { class: "agenda-item", href: "#/calendar" },
                  h("span", { class: "agenda-time" }, timeLabel(b.slot.slice(11))),
                  h("span", { class: "agenda-who" }, h("b", null, b.name), b.service ? h("span", null, b.service) : null),
                  badge(b.booking_status)
                )
              )
            )
          )
        : h("p", { class: "muted dash-empty" }, "No calls booked. Visitors can book one from any page on the site.")
    );
  }

  function recentCard(recent) {
    const { TYPE_INFO } = window.MzAdmin;
    return h(
      "section",
      { class: "card dash-card" },
      h("header", { class: "dash-card-head" }, h("h2", null, "Latest from the website")),
      recent.length
        ? h(
            "div",
            { class: "feed" },
            recent.map((r) =>
              h(
                "a",
                { class: "feed-item" + (r.status === "new" ? " unread" : ""), href: `#/${TYPE_INFO[r.type].route}/${r.id}` },
                h("span", { class: "feed-icon" }, icon(TYPE_INFO[r.type].route)),
                h("span", { class: "feed-text" }, h("b", null, r.name), h("span", null, TYPE_INFO[r.type].singular)),
                h("span", { class: "muted" }, timeAgo(r.created_at))
              )
            )
          )
        : h("p", { class: "muted dash-empty" }, "Form submissions from the website will appear here.")
    );
  }

  ROUTES.dashboard = async function () {
    const d = await api("GET", "/dashboard");
    const hour = Number(new Date().toLocaleString("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    const name = firstNameFromEmail(d.me);
    const create = (href, iconName, label) => h("a", { class: "btn btn-sm", href }, icon(iconName), label);
    const liveChip = (href, n, label) => h("a", { class: "live-chip", href }, h("b", null, n.toLocaleString("en-IN")), ` ${label}`);
    const urgent = d.attention.filter((a) => a.tone === "red").length;

    main.replaceChildren(
      h(
        "div",
        { class: "dash-hero" },
        h(
          "div",
          null,
          h("div", { class: "dash-date" }, dayLabel(d.today, true)),
          h("h1", null, name ? `${greeting}, ${name}` : greeting),
          h("p", { class: "dash-brief" }, brief(d))
        ),
        h("div", { class: "dash-create" }, create("#/blog/new", "blog", "Post"), create("#/jobs/new", "jobs", "Job"), create("#/vlogs/new", "vlogs", "Vlog"), create("#/portfolio/new", "portfolio", "Project"))
      ),
      h(
        "div",
        { class: "dash-main" },
        h(
          "section",
          { class: "card dash-card" },
          h(
            "header",
            { class: "dash-card-head" },
            h("h2", null, "Needs attention"),
            d.attention.length ? h("span", { class: "count-pill" + (urgent ? " urgent" : "") }, String(d.attention.length)) : null
          ),
          attentionList(d.attention)
        ),
        weekCard(d.week)
      ),
      h("div", { class: "dash-row" }, pipelineCard(d.stages, d.wonThisMonth), agendaCard(d.upcoming, d.today), recentCard(d.recent)),
      h(
        "div",
        { class: "live-strip" },
        h("span", { class: "muted" }, "Live on the site:"),
        liveChip("#/jobs", d.live.jobs, d.live.jobs === 1 ? "open role" : "open roles"),
        liveChip("#/blog", d.live.posts, d.live.posts === 1 ? "article" : "articles"),
        liveChip("#/vlogs", d.live.vlogs, d.live.vlogs === 1 ? "vlog" : "vlogs"),
        liveChip("#/portfolio", d.live.projects, d.live.projects === 1 ? "project" : "projects"),
        liveChip("#/subscribers", d.live.subscribers, d.live.subscribers === 1 ? "subscriber" : "subscribers"),
        h("a", { class: "live-site", href: "/", target: "_blank", rel: "noopener" }, "Open website ", icon("external"))
      )
    );
  };

  /* ---------- Settings additions ---------- */

  const baseSettings = ROUTES.settings;
  ROUTES.settings = async function () {
    await baseSettings();
    const list = h("div", { class: "table-wrap" });
    async function load() {
      const { items } = await api("GET", "/backups");
      list.replaceChildren(
        items.length
          ? h(
              "table",
              null,
              h(
                "tbody",
                null,
                items.map((b) =>
                  h("tr", null, h("td", null, b.name), h("td", { class: "muted" }, fmtDate(b.created_at)), h("td", { class: "muted" }, `${(b.size / 1024).toFixed(0)} KB`), h("td", { style: "text-align:right" }, h("a", { class: "btn btn-sm", href: `${API}/backups/${encodeURIComponent(b.name)}` }, "Download")))
                )
              )
            )
          : h("div", { class: "empty" }, "No backups yet.")
      );
    }
    const container = main.querySelector("div[style*='max-width']") || main;

    const biginBox = h("div", { class: "notice" }, "Checking Bigin sync…");
    async function loadBigin() {
      const s = await api("GET", "/bigin/status");
      if (!s.enabled) {
        biginBox.className = "notice";
        biginBox.replaceChildren("Bigin sync is off. Add the BIGIN_FORM_* keys to the server settings to forward website leads to Bigin.");
        return;
      }
      biginBox.className = "notice" + (s.failed ? "" : " ok");
      biginBox.replaceChildren(
        h("div", null, `On — ${s.sent} sent to Bigin, ${s.pending} waiting, ${s.failed} failed.`),
        s.failures.length
          ? h("ul", { style: "margin:8px 0 0;padding-left:18px" }, s.failures.map((f) => h("li", null, `${f.kind} #${f.ref_id} (${f.attempts} tries): ${f.last_error}`)))
          : null,
        s.failed ? h("div", { style: "margin-top:8px" }, h("button", { class: "btn btn-sm", onclick: () => api("POST", "/bigin/retry").then((r) => (toast(`Retrying ${r.retried}`), setTimeout(() => loadBigin().catch(fail), 3000))).catch(fail) }, "Retry failed")) : null
      );
    }
    container.append(
      h(
        "div",
        { class: "card", style: "display:grid;gap:14px" },
        h("h2", null, "Bigin CRM"),
        h("p", { class: "muted", style: "margin:0" }, "Every contact message, call booking, job application and newsletter sign-up is copied to Bigin as a Contact, with the details in its Description. If Bigin is unreachable, it's retried automatically."),
        biginBox,
        h("div", null, h("a", { class: "btn btn-sm", href: "https://bigin.zoho.in/", target: "_blank", rel: "noopener" }, "Open Bigin ↗"))
      )
    );
    loadBigin().catch(fail);

    container.append(
      h(
        "div",
        { class: "card", style: "display:grid;gap:14px" },
        h("h2", null, "Database backups"),
        h("p", { class: "muted", style: "margin:0" }, "A backup is made automatically every day; the latest 14 are kept on the server. Download one now and then to keep an off-site copy. (Uploaded resumes and images aren't included.)"),
        list,
        h("div", null, h("button", { class: "btn", onclick: () => api("POST", "/backups").then(() => (toast("Backup created"), load())).catch(fail) }, "Back up now"))
      )
    );
    load().catch(fail);
  };

  ROUTES.hiring = pipelineView("hiring");
  ROUTES.leads = pipelineView("leads");
  ROUTES.calendar = calendar;
  ROUTES.analytics = analytics;

  // admin.js calls this whenever it refreshes the inbox counts (sign-in, changes).
  window.MzAdmin.onRefreshCounts = refreshPendingBookings;
})();
