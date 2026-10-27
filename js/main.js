/* =========================================================
   Magzest — Shared site behaviour
   Loaded on every page. Handles: mobile nav, sticky navbar,
   scroll progress bar, AOS init, icon rendering, FAQ
   accordion, cookie consent and the appointment booking
   modal.
   ========================================================= */

(function () {
  "use strict";

  /* ---------- Cookie helpers (first-party, no third-party tracking) ---------- */
  function setCookie(name, value, days) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = name + "=" + encodeURIComponent(value) + "; expires=" + expires + "; path=/; SameSite=Lax" + secure;
  }
  function getCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /* ---------- Mobile nav ---------- */
  const mobileToggle = document.getElementById("mobile-menu-toggle");
  const mobileMenu = document.getElementById("mobile-menu");
  if (mobileToggle && mobileMenu) {
    const setMenuOpen = (isOpen) => {
      mobileMenu.classList.toggle("flex", isOpen);
      mobileMenu.classList.toggle("hidden", !isOpen);
      mobileToggle.setAttribute("aria-expanded", String(isOpen));
      mobileToggle.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
      // Lucide swaps the <i> for an <svg>, so replace the icon node instead of
      // relying on the original element still being there.
      const icon = mobileToggle.querySelector("[data-menu-icon]");
      if (icon) icon.outerHTML = `<i data-lucide="${isOpen ? "x" : "menu"}" data-menu-icon class="w-6 h-6"></i>`;
      if (window.lucide) window.lucide.createIcons();
    };
    mobileToggle.addEventListener("click", () => setMenuOpen(mobileMenu.classList.contains("hidden")));
    // Links and the consultation button inside the menu both close it
    mobileMenu.querySelectorAll("a, button").forEach((el) => el.addEventListener("click", () => setMenuOpen(false)));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !mobileMenu.classList.contains("hidden")) {
        setMenuOpen(false);
        mobileToggle.focus();
      }
    });
  }

  /* ---------- Sticky navbar shadow on scroll + scroll progress ---------- */
  const navbar = document.getElementById("navbar");
  const progressBar = document.getElementById("scroll-progress");
  const backToTop = document.getElementById("back-to-top");

  function onScroll() {
    const scrollTop = window.scrollY;
    if (navbar) navbar.classList.toggle("scrolled", scrollTop > 8);

    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    if (progressBar) progressBar.style.width = pct + "%";

    if (backToTop) backToTop.classList.toggle("opacity-0", scrollTop < 400);
    if (backToTop) backToTop.classList.toggle("pointer-events-none", scrollTop < 400);
  }
  document.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (backToTop) {
    backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  /* ---------- Interactive mouse-parallax tilt (hero + service mockups) ---------- */
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const attachParallaxTilt = (container, target, restX, restY, rangeX, rangeY) => {
      if (!container || !target) return;
      container.addEventListener("mousemove", (e) => {
        const rect = container.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        target.style.transform =
          `perspective(1000px) rotateX(${(restX - py * rangeX).toFixed(2)}deg) rotateY(${(restY + px * rangeY).toFixed(2)}deg)`;
      });
      container.addEventListener("mouseleave", () => { target.style.transform = ""; });
    };

    const heroScene = document.querySelector(".hero-3d-scene");
    const heroStage = document.querySelector(".hero-3d-stage");
    if (heroScene && heroStage) {
      heroScene.addEventListener("mouseenter", () => { heroStage.style.animationPlayState = "paused"; });
      heroScene.addEventListener("mouseleave", () => { heroStage.style.animationPlayState = "running"; });
      attachParallaxTilt(heroScene, heroStage, 10, -20, 16, 24);
    }

    document.querySelectorAll(".mock-stage").forEach((stage) => {
      attachParallaxTilt(stage, stage.querySelector(".mock-tilt"), 3, -8, 10, 14);
    });
  }

  /* ---------- AOS (scroll reveal) init ---------- */
  // aos.css hides every [data-aos] element until AOS reveals it. When the
  // script didn't load, or the visitor asked for reduced motion, drop the
  // attributes so content is simply shown.
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (window.AOS && !prefersReducedMotion) {
    window.AOS.init({ duration: 600, once: true, offset: 60, easing: "ease-out-cubic" });
  } else {
    document.querySelectorAll("[data-aos]").forEach((el) => el.removeAttribute("data-aos"));
  }

  /* ---------- Lucide icons ---------- */
  if (window.lucide) window.lucide.createIcons();

  /* ---------- Footer year ---------- */
  document.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = new Date().getFullYear();
  });

  /* ---------- Cookie consent (GDPR-style) ---------- */
  const cookieBanner = document.getElementById("cookie-consent");
  const COOKIE_KEY = "magzest-cookie-consent";
  if (cookieBanner && !getCookie(COOKIE_KEY)) {
    setTimeout(() => cookieBanner.classList.add("visible"), 1200);
  }
  document.querySelectorAll("[data-cookie-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCookie(COOKIE_KEY, btn.getAttribute("data-cookie-choice"), 365);
      if (cookieBanner) cookieBanner.classList.remove("visible");
    });
  });
  // "Change cookie preferences" (Cookie Policy page): forget the choice and ask again
  document.querySelectorAll("[data-cookie-reset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setCookie(COOKIE_KEY, "", -1);
      if (cookieBanner) cookieBanner.classList.add("visible");
    });
  });

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll(".faq-item").forEach((item) => {
    const question = item.querySelector(".faq-question");
    const answer = item.querySelector(".faq-answer");
    if (!question || !answer) return;
    question.setAttribute("aria-expanded", "false");
    question.addEventListener("click", () => {
      const isOpen = item.classList.contains("open");
      item.closest("[data-faq-group]") &&
        item.parentElement.querySelectorAll(".faq-item.open").forEach((openItem) => {
          if (openItem !== item) {
            openItem.classList.remove("open");
            openItem.querySelector(".faq-answer").style.maxHeight = null;
            openItem.querySelector(".faq-question").setAttribute("aria-expanded", "false");
          }
        });
      item.classList.toggle("open", !isOpen);
      question.setAttribute("aria-expanded", String(!isOpen));
      answer.style.maxHeight = !isOpen ? answer.scrollHeight + "px" : null;
    });
  });

  /* ---------- Appointment booking modal ---------- */
  const bookingModal = document.getElementById("booking-modal");
  const bookingForm = document.getElementById("booking-form");
  const bookingSuccess = document.getElementById("booking-success");
  let bookingOpener = null;
  function openBooking(opener) {
    if (!bookingModal) return;
    bookingOpener = opener || document.activeElement;
    bookingModal.classList.remove("hidden-state");
    bookingModal.setAttribute("aria-hidden", "false");
    document.documentElement.style.overflow = "hidden";
    const first = bookingModal.querySelector('input[name="first_name"]') || bookingModal.querySelector("button");
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 50);
  }
  function closeBooking() {
    if (!bookingModal || bookingModal.classList.contains("hidden-state")) return;
    bookingModal.classList.add("hidden-state");
    bookingModal.setAttribute("aria-hidden", "true");
    document.documentElement.style.overflow = "";
    if (bookingOpener && bookingOpener.focus) bookingOpener.focus({ preventScroll: true });
  }
  document.querySelectorAll("[data-open-booking]").forEach((btn) => {
    btn.addEventListener("click", () => openBooking(btn));
  });
  document.querySelectorAll("[data-close-booking]").forEach((btn) => {
    btn.addEventListener("click", closeBooking);
  });
  if (bookingModal) {
    // Click on the dimmed backdrop (not the card) closes the modal
    bookingModal.addEventListener("click", (e) => { if (e.target === bookingModal) closeBooking(); });
    bookingModal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return closeBooking();
      if (e.key !== "Tab") return;
      // Keep keyboard focus inside the dialog while it's open
      const focusable = [...bookingModal.querySelectorAll("a[href], button, input, select, textarea")].filter(
        (el) => !el.disabled && el.name !== "_honey" && el.offsetParent !== null
      );
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  // The consultation modal collects the same details as the contact page and
  // is sent the same way (straight to Bigin).
  if (bookingForm) {
    const bookingSubmitBtn = bookingForm.querySelector('button[type="submit"]');
    const bookingSubmitLabel = document.getElementById("booking-submit-label");

    // Clear a field's error as soon as it's edited.
    ["input", "change"].forEach((type) =>
      bookingForm.addEventListener(type, (e) => {
        if (e.target.name) window.MagzestForm.clearError(e.target);
      })
    );

    bookingForm.addEventListener("submit", (e) => {
      e.preventDefault();
      let firstInvalid = null;
      Array.from(bookingForm.elements).forEach((field) => {
        if (!field.name || field.name === "_honey") return;
        const value = field.value.trim();
        let message = "";
        if (field.required && !value) message = "This field is required.";
        else if (field.type === "email" && value && !window.MagzestForm.validateEmail(value)) message = "Enter a valid email address.";
        if (!message) return window.MagzestForm.clearError(field);
        window.MagzestForm.showError(field, message);
        if (!firstInvalid) firstInvalid = field;
      });
      if (firstInvalid) {
        bookingForm.classList.add("form-shake");
        setTimeout(() => bookingForm.classList.remove("form-shake"), 400);
        firstInvalid.focus();
        return;
      }

      if (bookingSubmitBtn) bookingSubmitBtn.disabled = true;
      if (bookingSubmitLabel) bookingSubmitLabel.textContent = "Sending…";

      window.MagzestForm.submit(bookingForm, "contact")
        .then(() => {
          bookingForm.classList.add("hidden");
          if (bookingSuccess) bookingSuccess.classList.remove("hidden");
        })
        .catch(() => {
          if (bookingSubmitBtn) bookingSubmitBtn.disabled = false;
          if (bookingSubmitLabel) bookingSubmitLabel.textContent = "Couldn't send — try again";
        });
    });
  }

  /* ---------- Newsletter forms (footer + blog hero) ---------- */
  document.querySelectorAll(".newsletter-form").forEach((form) => {
    const emailInput = form.querySelector('input[type="email"]');
    if (!emailInput) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!window.MagzestForm.validateEmail(emailInput.value.trim())) {
        window.MagzestForm.showError(emailInput, "Enter a valid email address.");
        form.classList.add("form-shake");
        setTimeout(() => form.classList.remove("form-shake"), 400);
        emailInput.focus();
        return;
      }
      window.MagzestForm.clearError(emailInput);
      const submitBtn = form.querySelector("button");
      if (submitBtn) submitBtn.disabled = true;

      window.MagzestForm.submit(form, "newsletter")
        .then(() => {
          form.reset();
          if (submitBtn) {
            submitBtn.classList.add("newsletter-subscribed");
            setTimeout(() => {
              submitBtn.classList.remove("newsletter-subscribed");
              submitBtn.disabled = false;
            }, 2000);
          }
        })
        .catch(() => {
          if (submitBtn) submitBtn.disabled = false;
          window.MagzestForm.showError(emailInput, "Something went wrong — please try again.");
        });
    });
  });

  /* ---------- Click-to-load embeds: vlog YouTube/Vimeo players, Contact page map ----------
     Nothing from the third party loads (and no third-party cookies are set)
     until the visitor clicks. */
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-video-embed]");
    if (!link) return;
    e.preventDefault();
    const iframe = document.createElement("iframe");
    iframe.src = link.dataset.videoEmbed;
    iframe.title = link.dataset.videoTitle || "Video";
    iframe.allow = "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.className = "w-full h-full border-0";
    link.replaceWith(iframe);
  });

  /* ---------- Typewriter tagline (home hero only) ---------- */
  const typewriterEl = document.getElementById("typewriter-text");
  if (typewriterEl) {
    const phrases = ["Websites.", "Mobile Apps.", "AI-Powered Software.", "Digital Growth."];
    let phraseIndex = 0;
    let charIndex = 0;
    let deleting = false;

    function tick() {
      const current = phrases[phraseIndex];
      if (!deleting) {
        charIndex++;
        typewriterEl.textContent = current.slice(0, charIndex);
        if (charIndex === current.length) {
          deleting = true;
          setTimeout(tick, 1400);
          return;
        }
      } else {
        charIndex--;
        typewriterEl.textContent = current.slice(0, charIndex);
        if (charIndex === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % phrases.length;
        }
      }
      setTimeout(tick, deleting ? 40 : 85);
    }
    tick();
  }

  /* ---------- Generic form validation helper ---------- */
  window.MagzestForm = {
    // The site is plain static files, so forms are sent to FormSubmit
    // (form ID tied to contact@magzest.tech), which emails them to the team.
    FORMSUBMIT_URL: "https://formsubmit.co/ajax/1bd2a3fa-5299-44c1-aba9-b88f9db64c74",
    // Contact and consultation leads are copied to the whole team.
    LEADS_CC: "ranjithkumar@magzest.in,nithin@magzest.tech,hameed@magzest.tech,srilatha@magzest.tech,harini@magzest.tech",
    SUBJECTS: {
      contact: "New contact form submission — Magzest website",
      booking: "New consultation booking — Magzest website",
      application: "New job application — Magzest website",
      newsletter: "New newsletter signup — Magzest website",
    },
    submitToFormSubmit(form, kind) {
      const data = new FormData(form);
      data.set("_subject", this.SUBJECTS[kind] || "New submission — Magzest website");
      data.set("_captcha", "false");
      data.set("_template", "table");
      if (kind === "contact" || kind === "booking") data.set("_cc", this.LEADS_CC);
      return fetch(this.FORMSUBMIT_URL, { method: "POST", headers: { Accept: "application/json" }, body: data })
        .then((res) => res.json().catch(() => ({})).then((body) => ({ res, body })))
        .then(({ res, body }) => {
          if (res.ok && String(body.success) === "true") return { ok: true };
          throw new Error(body.message || "Submission failed");
        });
    },
    // Bigin "Contact us" web form. These keys are public: they're in the
    // hosted form's page source.
    BIGIN: {
      URL: "https://bigin.zoho.in/crm/WebForm",
      xnQsjsdp: "0f1973ac752a5fda9ba5c0722cb0c68456a08d5de2c26a3cc9adee4f6de250f4",
      xmIwtLD: "1285e445112b8d9f854d6e3d70003655577adbe3544a5544801849d029d7fe759c025d416a1c97eeaa559d56a06a155a",
      actionType: "Q29udGFjdHM=",
    },
    // Contact leads go straight to Bigin as a Contact.
    submitToBigin(form) {
      const f = new FormData(form);
      if (f.get("_honey")) return Promise.resolve({ ok: true });
      const get = (k) => String(f.get(k) || "").trim();
      const data = new FormData();
      data.set("xnQsjsdp", this.BIGIN.xnQsjsdp);
      data.set("zc_gad", "");
      data.set("xmIwtLD", this.BIGIN.xmIwtLD);
      data.set("actionType", this.BIGIN.actionType);
      data.set("rmsg", "true");
      data.set("returnURL", "null");
      const fields = {
        "First Name": get("first_name"),
        "Last Name": get("last_name"),
        Email: get("email"),
        Mobile: get("phone"),
        "Mailing City": get("city"),
        "Mailing State": get("state"),
        Description: `Source: Website — ${get("source") || "Contact form"}\n\n${get("message")}`,
      };
      Object.entries(fields).forEach(([k, v]) => v && data.set(k, v));
      // Bigin sends no CORS headers, so the reply can't be read; the request
      // still reaches Bigin, and only a network failure rejects.
      return fetch(this.BIGIN.URL, { method: "POST", mode: "no-cors", body: data }).then(() => ({ ok: true }));
    },
    // Contact leads go to Bigin; everything else is emailed through FormSubmit.
    // Resolves on success, rejects on failure.
    submit(form, kind) {
      return kind === "contact" ? this.submitToBigin(form) : this.submitToFormSubmit(form, kind);
    },
    validateEmail: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    showError(input, message) {
      this.clearError(input);
      const err = document.createElement("p");
      err.className = "form-error text-red-500 text-xs mt-1";
      err.textContent = message;
      input.classList.add("border-red-500", "focus:outline-red-500");
      input.insertAdjacentElement("afterend", err);
    },
    clearError(input) {
      input.classList.remove("border-red-500", "focus:outline-red-500");
      const next = input.nextElementSibling;
      if (next && next.classList.contains("form-error")) next.remove();
    },
  };
})();
