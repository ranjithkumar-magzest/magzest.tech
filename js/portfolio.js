/* =========================================================
   Magzest — Portfolio page behaviour
   Filters project cards by category using the filter bar.
   ========================================================= */

(function () {
  "use strict";

  const buttons = document.querySelectorAll(".filter-btn");
  const cards = document.querySelectorAll("[data-category]");
  if (!buttons.length || !cards.length) return;

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.getAttribute("data-filter");
      cards.forEach((card) => {
        const match = filter === "all" || card.getAttribute("data-category") === filter;
        card.classList.toggle("hidden", !match);
      });
    });
  });
})();
