/* =========================================================
   Magzest — Contact form
   Validates client-side, then submits to the Magzest server
   (POST /api/forms/contact), which saves it and emails the team.
   ========================================================= */

(function () {
  "use strict";

  const form = document.getElementById("contact-form");
  if (!form) return;

  const firstNameInput = document.getElementById("contact-first-name");
  const lastNameInput = document.getElementById("contact-last-name");
  const emailInput = document.getElementById("contact-email");
  const messageInput = document.getElementById("contact-message");
  const submitBtn = document.getElementById("contact-submit");
  const submitLabel = document.getElementById("contact-submit-label");
  const successBox = document.getElementById("contact-success");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let valid = true;

    [firstNameInput, lastNameInput, emailInput, messageInput].forEach((el) => el && window.MagzestForm.clearError(el));

    // Only Last Name is required (it's the one mandatory field in Bigin).
    if (!lastNameInput.value.trim()) {
      window.MagzestForm.showError(lastNameInput, "Please enter your last name.");
      valid = false;
    }
    const email = emailInput.value.trim();
    if (email && !window.MagzestForm.validateEmail(email)) {
      window.MagzestForm.showError(emailInput, "Please enter a valid email address.");
      valid = false;
    }

    if (!valid) return;

    submitBtn.disabled = true;
    if (submitLabel) submitLabel.textContent = "Sending…";

    window.MagzestForm.submit(form, "contact")
      .then(() => {
        form.classList.add("hidden");
        if (successBox) successBox.classList.remove("hidden");
      })
      .catch((err) => {
        submitBtn.disabled = false;
        if (submitLabel) submitLabel.textContent = err.fieldErrors ? "Send Message" : "Couldn't send — try again";
      });
  });
})();
