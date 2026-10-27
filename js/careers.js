/* =========================================================
   Magzest — Careers page behaviour
   Wires "Apply Now" job buttons to the application form,
   validates the form on submit, previews the uploaded resume
   file name, and submits to the Magzest server
   (POST /api/forms/application), which stores the resume and
   emails the team with it attached.
   ========================================================= */

(function () {
  "use strict";

  const form = document.getElementById("application-form");
  if (!form) return;

  const nameInput = document.getElementById("app-name");
  const emailInput = document.getElementById("app-email");
  const positionSelect = document.getElementById("app-position");
  const resumeInput = document.getElementById("app-resume");
  const resumeLabel = document.getElementById("resume-filename");
  const submitBtn = form.querySelector('button[type="submit"]');
  const submitLabel = document.getElementById("application-submit-label");
  const successBox = document.getElementById("application-success");
  const errorBox = document.getElementById("application-error");

  document.querySelectorAll("[data-apply-for]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const role = btn.getAttribute("data-apply-for");
      if (positionSelect) positionSelect.value = role;
      const formSection = document.getElementById("apply-form-section");
      if (formSection) formSection.scrollIntoView({ behavior: "smooth", block: "start" });
      if (nameInput) nameInput.focus({ preventScroll: true });
    });
  });

  if (resumeInput && resumeLabel) {
    resumeInput.addEventListener("change", () => {
      resumeLabel.textContent = resumeInput.files.length ? resumeInput.files[0].name : "No file chosen";
    });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let valid = true;

    [nameInput, emailInput, positionSelect].forEach((el) => el && window.MagzestForm.clearError(el));
    if (errorBox) errorBox.classList.add("hidden");

    if (!nameInput.value.trim()) {
      window.MagzestForm.showError(nameInput, "Please enter your full name.");
      valid = false;
    }
    if (!window.MagzestForm.validateEmail(emailInput.value.trim())) {
      window.MagzestForm.showError(emailInput, "Please enter a valid email address.");
      valid = false;
    }
    if (!positionSelect.value) {
      window.MagzestForm.showError(positionSelect, "Please select a position.");
      valid = false;
    }

    if (!valid) return;

    submitBtn.disabled = true;
    if (submitLabel) submitLabel.textContent = "Sending…";

    window.MagzestForm.submit(form, "application")
      .then(() => {
        form.classList.add("hidden");
        if (successBox) successBox.classList.remove("hidden");
      })
      .catch((err) => {
        submitBtn.disabled = false;
        if (submitLabel) submitLabel.textContent = "Submit Application";
        if (errorBox && !err.fieldErrors) errorBox.classList.remove("hidden");
      });
  });
})();
