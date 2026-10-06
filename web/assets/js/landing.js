/* Landing page: scroll-driven fallback, counters, live stats, video handling. */
(function () {
  "use strict";
  const { api, reducedMotion } = window.MCL;
  const supportsSDA = window.CSS && CSS.supports && CSS.supports("animation-timeline: view()");

  function setupVideos() {
    const hero = document.querySelector(".hero-video");
    const accent = document.querySelector(".accent-video");
    if (reducedMotion()) {
      if (hero) { hero.removeAttribute("autoplay"); hero.pause(); }
      return; // posters only
    }
    if (hero) hero.play().catch(() => { /* autoplay blocked: poster stays */ });
    if (accent && "IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            if (!accent.src) accent.src = accent.dataset.src;
            accent.play().catch(() => {});
          } else if (accent.src) accent.pause();
        });
      }, { rootMargin: "200px" });
      io.observe(accent);
    }
  }

  // Fallback for browsers without CSS scroll-driven animations.
  function setupFallback() {
    if (supportsSDA || reducedMotion() || !("IntersectionObserver" in window)) return;
    document.documentElement.classList.add("js-fallback");

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -15% 0px" });
    document.querySelectorAll(".stage, .reveal").forEach((el) => io.observe(el));

    const track = document.querySelector(".pipeline-track");
    const fill = document.querySelector(".meridian-fill");
    const video = document.querySelector(".hero-video");
    let ticking = false;
    function update() {
      ticking = false;
      if (track && fill) {
        const r = track.getBoundingClientRect();
        const line = window.innerHeight * 0.55; // the fill follows the 55% line of the viewport
        const p = Math.min(1, Math.max(0, (line - r.top) / r.height));
        fill.style.setProperty("--p", p.toFixed(4));
      }
      if (video && window.scrollY < window.innerHeight * 1.2) {
        video.style.setProperty("--parallax", (window.scrollY * 0.18).toFixed(1) + "px");
      }
    }
    window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  function animateCount(el) {
    const target = parseFloat(el.dataset.count);
    const decimals = parseInt(el.dataset.decimals || "0", 10);
    if (!isFinite(target)) return;
    if (reducedMotion()) { el.textContent = target.toFixed(decimals); return; }
    const start = performance.now(), duration = 1100;
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toFixed(decimals);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  async function setupStats() {
    const counters = document.querySelectorAll("#live-stats [data-count]");
    try { // show the live demo numbers when the server is up
      const stats = await api("/api/stats");
      counters.forEach((el) => {
        const v = stats[el.dataset.key];
        if (typeof v === "number") { el.dataset.count = v; el.textContent = Number(v).toFixed(parseInt(el.dataset.decimals || "0", 10)); }
      });
    } catch (_) { /* keep static figures */ }
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { animateCount(e.target); io.unobserve(e.target); } });
    }, { threshold: 0.6 });
    counters.forEach((el) => io.observe(el));
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupVideos();
    setupFallback();
    setupStats();
  });
})();
