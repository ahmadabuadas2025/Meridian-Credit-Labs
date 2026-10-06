/* Shared helpers: theme, API calls, formatting, escaping, toast. */
(function () {
  "use strict";
  const root = document.documentElement;

  function safeGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* private mode */ } }

  const saved = safeGet("mcl-theme");
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;

  function currentTheme() {
    if (root.dataset.theme) return root.dataset.theme;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function paintToggle(btn) {
    const dark = currentTheme() === "dark";
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
      opts.headers["Content-Type"] = "application/json";
    }
    let res;
    try { res = await fetch(path, opts); } catch (_) {
      throw new Error("Can't reach the demo server. Is 'python main.py serve' running?");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    return data;
  }

  const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const pct = (f, digits = 1) => (Number(f || 0) * 100).toFixed(digits) + "%";
  const OUTCOME_LABEL = { APPROVE: "Approved", DECLINE: "Declined", REVIEW: "In review", PENDING_REVIEW: "In review" };
  const pill = (status) => `<span class="pill pill-${escapeHtml(status)}">${OUTCOME_LABEL[status] || escapeHtml(status)}</span>`;
  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  let toastTimer;
  function toast(message) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.querySelector(".theme-toggle");
    if (btn) {
      paintToggle(btn);
      btn.addEventListener("click", () => {
        root.dataset.theme = currentTheme() === "dark" ? "light" : "dark";
        safeSet("mcl-theme", root.dataset.theme);
        paintToggle(btn);
      });
    }
    const header = document.querySelector(".site-header");
    if (header) {
      const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
    }
  });

  window.MCL = { api, escapeHtml, usd, pct, pill, when, toast, reducedMotion, safeGet, safeSet, OUTCOME_LABEL };
})();
