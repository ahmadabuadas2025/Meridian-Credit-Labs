/* Applicant dashboard: multi-step form, scenario quick-fill, animated result, my apps + inbox. */
(function () {
  "use strict";
  const { api, escapeHtml: esc, usd, pct, pill, when, toast, reducedMotion, safeGet, safeSet } = window.MCL;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const DOC_TYPES = ["government_id", "proof_of_income", "bank_statement"];
  const STORAGE_KEY = "mcl-my-apps";
  const docs = {};          // type -> {filename, text}
  let samples = [];         // from /api/samples
  let step = 0;

  const form = $("#apply-form");
  const steps = $$(".step", form);
  const alertBox = $("#form-alert");

  // --- validation (mirrors intake.py so errors show before the round trip) -------------
  const num = (v) => Number(String(v).replace(/[$,\s]/g, ""));
  const RULES = {
    0: {
      applicant_name: (v) => (v.trim() ? "" : "Enter a name. A made-up one is fine."),
      email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? "" : "Enter an email like name@example.com."),
    },
    1: {
      loan_amount: (v) => (!v.trim() ? "Enter an amount." : !isFinite(num(v)) ? "Amount must be a number."
        : num(v) <= 0 ? "Amount must be more than zero." : ""),
    },
    2: {
      stated_monthly_income: (v) => (!v.trim() || !isFinite(num(v)) ? "Enter your monthly income as a number."
        : num(v) <= 0 ? "Income must be more than zero." : ""),
      monthly_debts: (v) => (!v.trim() || !isFinite(num(v)) ? "Enter a number, or 0 if you have no debts."
        : num(v) < 0 ? "Debts can't be negative." : ""),
      years_employed: (v) => (!v.trim() || !isFinite(num(v)) ? "Enter a number of years."
        : num(v) < 0 ? "Years can't be negative." : ""),
      prior_delinquencies: (v) => (!/^\d+$/.test(v.trim()) ? "Enter a whole number, 0 or more." : ""),
    },
  };

  function setError(name, message) {
    const input = form.elements[name];
    const err = $(`#${name}-err`);
    if (input && input.setAttribute) input.setAttribute("aria-invalid", message ? "true" : "false");
    if (err) err.textContent = message;
  }

  function validateStep(i) {
    const rules = RULES[i] || {};
    let firstBad = null;
    Object.keys(rules).forEach((name) => {
      const msg = rules[name](form.elements[name].value);
      setError(name, msg);
      if (msg && !firstBad) firstBad = form.elements[name];
    });
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  Object.values(RULES).forEach((group) => Object.keys(group).forEach((name) => {
    form.elements[name].addEventListener("blur", (e) => { if (e.target.value) setError(name, group[name](e.target.value)); });
  }));

  // --- stepper ------------------------------------------------------------------------
  function showStep(i, focus = true) {
    step = i;
    steps.forEach((s, idx) => { s.hidden = idx !== i; });
    $$(".stepper li").forEach((li, idx) => {
      li.classList.toggle("done", idx < i);
      if (idx === i) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
    $("#back-btn").hidden = i === 0;
    $("#next-btn").hidden = i === steps.length - 1;
    $("#submit-btn").hidden = i !== steps.length - 1;
    if (focus) { const first = steps[i].querySelector("input, select, button"); if (first) first.focus(); }
  }

  $("#next-btn").addEventListener("click", () => { if (validateStep(step)) showStep(step + 1); });
  $("#back-btn").addEventListener("click", () => showStep(step - 1));
  form.addEventListener("keydown", (e) => { // Enter moves forward instead of submitting early
    if (e.key === "Enter" && e.target.tagName === "INPUT" && step < steps.length - 1) {
      e.preventDefault(); $("#next-btn").click();
    }
  });

  // --- documents ----------------------------------------------------------------------
  function renderDoc(type) {
    const doc = docs[type];
    const status = $(`#st-${type}`);
    status.textContent = doc ? `${doc.filename}, ${doc.text.length.toLocaleString()} characters` : "Not added";
    status.classList.toggle("added", !!doc);
    $(`[data-remove="${type}"]`).hidden = !doc;
  }

  $$("input[type=file]", form).forEach((input) => input.addEventListener("change", () => {
    const file = input.files[0];
    const type = input.dataset.type;
    if (!file) return;
    if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") {
      toast("Only plain-text .txt files are supported in this demo."); input.value = ""; return;
    }
    if (file.size > 50000) { toast("That file is larger than 50 KB. Try a shorter .txt file."); input.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => { docs[type] = { filename: file.name, text: String(reader.result) }; renderDoc(type); input.value = ""; };
    reader.onerror = () => toast("Couldn't read that file.");
    reader.readAsText(file);
  }));

  function sampleDoc(type, scenarioName) {
    const s = samples.find((x) => x.scenario === scenarioName) || samples[0];
    return s && (s.documents || []).find((d) => d.type === type);
  }
  $$("[data-sample]", form).forEach((btn) => btn.addEventListener("click", () => {
    const d = sampleDoc(btn.dataset.sample, "Complete + low risk");
    if (!d) { toast("Sample documents need the demo server running."); return; }
    docs[d.type] = { filename: d.filename, text: d.text };
    renderDoc(d.type);
  }));
  $$("[data-remove]", form).forEach((btn) => btn.addEventListener("click", () => {
    delete docs[btn.dataset.remove]; renderDoc(btn.dataset.remove);
    $(`input[data-type="${btn.dataset.remove}"]`).focus();
  }));

  // --- scenarios ----------------------------------------------------------------------
  function fill(sample) {
    ["applicant_name", "email", "loan_amount", "term_months", "purpose", "stated_monthly_income",
      "monthly_debts", "years_employed", "prior_delinquencies"].forEach((k) => {
      form.elements[k].value = sample[k]; setError(k, "");
    });
    const band = form.querySelector(`input[name=credit_band][value="${sample.credit_band}"]`);
    if (band) band.checked = true;
    DOC_TYPES.forEach((t) => { delete docs[t]; });
    (sample.documents || []).forEach((d) => { docs[d.type] = { filename: d.filename, text: d.text }; });
    DOC_TYPES.forEach(renderDoc);
  }

  $$("[data-scenario]").forEach((btn) => btn.addEventListener("click", () => {
    const s = samples.find((x) => x.scenario === btn.dataset.scenario);
    if (!s) { toast("Scenarios need the demo server running (python main.py serve)."); return; }
    resetView();
    fill(s);
    $$("[data-scenario]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    showStep(3, false);
    $("#submit-btn").focus();
    toast(`Filled in "${s.scenario}". Review the documents, then submit.`);
  }));

  // --- submit + animated result -------------------------------------------------------
  function payload() {
    const f = form.elements;
    return {
      applicant_name: f.applicant_name.value, email: f.email.value,
      loan_amount: f.loan_amount.value, term_months: f.term_months.value, purpose: f.purpose.value,
      stated_monthly_income: f.stated_monthly_income.value, monthly_debts: f.monthly_debts.value,
      years_employed: f.years_employed.value, prior_delinquencies: f.prior_delinquencies.value,
      credit_band: (form.querySelector("input[name=credit_band]:checked") || {}).value,
      documents: Object.entries(docs).map(([type, d]) => ({ type, filename: d.filename, text: d.text })),
    };
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    alertBox.textContent = "";
    for (let i = 0; i < 3; i++) { if (!validateStep(i)) { showStep(i); validateStep(i); return; } }
    const btn = $("#submit-btn");
    btn.disabled = true; btn.textContent = "Submitting";
    try {
      const result = await api("/api/applications", { method: "POST", body: payload() });
      remember(result.id);
      await showResult(result);
      refreshSide();
    } catch (err) {
      alertBox.textContent = err.message; alertBox.focus();
    } finally {
      btn.disabled = false; btn.textContent = "Submit application";
    }
  });

  const NEXT = {
    APPROVE: "Your (mock) offer is ready. This demo stops at the decision, so no money is sent.",
    DECLINE: "You can apply again in 30 days, or with updated documents. The reason above tells you what to change.",
    REVIEW: "An underwriter will look at your application. You'll get a notice in your inbox when they decide.",
  };
  const HEADLINE = { APPROVE: "You're approved", DECLINE: "We can't approve this one", REVIEW: "An underwriter will take a look" };

  function stages(r) {
    const d = r.auto_decision, x = r.extracted, a = r.application;
    const decider = d.rules_fired[d.rules_fired.length - 1];
    return [
      ["Intake", `${usd(a.loan_amount)} over ${a.term_months} months, ${a.documents.length} of 3 documents`],
      ["Document AI (mock)", x.monthly_income != null
        ? `Read ${esc(x.employer || "an employer")} and ${usd(x.monthly_income)} a month from your pay stub`
        : "No income figure found, so there was nothing to verify"],
      ["Risk score (mock)", `Score ${r.risk.score} out of 100, debt-to-income ${pct(r.risk.dti)}`],
      ["Lending rules", decider.id === "R7" ? "All seven rules passed (R7 approves)"
        : `Stopped at ${esc(decider.id)}: the check "${esc(decider.name.toLowerCase())}" did not pass`],
      ["Human review", d.outcome === "REVIEW" ? "Queued for an underwriter" : "Not needed for this outcome"],
      ["Decision and notice", `Notice sent to ${esc(a.email)} (mock, nothing leaves this computer)`],
    ];
  }

  function wait(ms) { return new Promise((res) => setTimeout(res, reducedMotion() ? 0 : ms)); }

  async function showResult(r) {
    form.hidden = true;
    const result = $("#result");
    result.hidden = false;
    $("#result-title").textContent = `Reviewing application ${r.id}`;
    $("#result-title").focus();
    const tl = $("#timeline");
    $("#decision").innerHTML = "";
    const list = stages(r);
    tl.innerHTML = list.map(([t]) => `<li class="tl-item" data-state="waiting"><span class="tl-dot" aria-hidden="true"></span><div><p class="tl-title">${t}</p><p class="tl-detail"></p></div></li>`).join("");
    const items = $$(".tl-item", tl);
    for (let i = 0; i < items.length; i++) {
      items[i].dataset.state = "active";
      await wait(420);
      items[i].querySelector(".tl-detail").innerHTML = list[i][1];
      items[i].dataset.state = (i === 4 && r.auto_decision.outcome !== "REVIEW") ? "skipped" : "done";
    }
    renderDecision(r);
  }

  function renderDecision(r) {
    const d = r.auto_decision;
    const missing = d.missing_items.length
      ? `<div class="missing"><p>Still needed:</p><ul>${d.missing_items.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : "";
    $("#result-title").textContent = `Application ${r.id}`;
    $("#decision").innerHTML = `
      <article class="decision decision-${d.outcome}">
        <header><span class="pill pill-${d.outcome}">${{ APPROVE: "Approved", DECLINE: "Declined", REVIEW: "In review" }[d.outcome]}</span>
          <h3>${HEADLINE[d.outcome]}</h3></header>
        <p class="decision-reason">${esc(d.reason)}</p>
        ${missing}
        <dl class="figures num">
          <div><dt>Mock risk score</dt><dd>${d.risk_score}</dd></div>
          <div><dt>Debt-to-income</dt><dd>${pct(d.dti)}</dd></div>
          <div><dt>Est. monthly payment</dt><dd>${usd(r.risk.estimated_payment)}</dd></div>
        </dl>
        <div class="next"><p class="next-label">What happens next</p><p>${NEXT[d.outcome]}</p></div>
        <div class="decision-actions">
          <button type="button" class="btn btn-primary" id="again-btn">Start another application</button>
          <a class="btn btn-ghost" href="ops.html#${encodeURIComponent(r.id)}">See it in the underwriter console</a>
        </div>
      </article>`;
    $("#again-btn").addEventListener("click", () => { resetView(); showStep(0); });
  }

  function resetView() {
    $("#result").hidden = true;
    form.hidden = false;
    alertBox.textContent = "";
  }

  // --- my applications + inbox --------------------------------------------------------
  function myIds() {
    try { const ids = JSON.parse(safeGet(STORAGE_KEY) || "[]"); return Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : []; }
    catch (_) { return []; }
  }
  function remember(id) { const ids = myIds().filter((x) => x !== id); ids.unshift(id); safeSet(STORAGE_KEY, JSON.stringify(ids.slice(0, 20))); }

  async function refreshSide() {
    const ids = myIds();
    const appsEl = $("#my-apps"), inboxEl = $("#inbox");
    if (!ids.length) {
      appsEl.innerHTML = `<li class="empty">Applications you submit show up here, with their latest status.</li>`;
      inboxEl.innerHTML = `<li class="empty">Decision notices land here. Submit an application or try a scenario above.</li>`;
      return;
    }
    const details = await Promise.all(ids.map((id) => api(`/api/applications/${encodeURIComponent(id)}`).catch(() => null)));
    const live = details.filter(Boolean);
    appsEl.innerHTML = live.length ? live.map((r) => `
      <li><a class="my-app" href="ops.html#${encodeURIComponent(r.id)}">
        <span class="my-app-top"><strong class="num">${esc(r.id)}</strong>${pill(r.status)}</span>
        <span class="my-app-sub num">${usd(r.application.loan_amount)} over ${r.application.term_months} months</span>
      </a></li>`).join("") : `<li class="empty">Your earlier applications were cleared when the demo data was reset.</li>`;
    try {
      const messages = await api(`/api/outbox?ids=${encodeURIComponent(live.map((r) => r.id).join(","))}`);
      inboxEl.innerHTML = messages.length ? messages.map((m) => `
        <li class="msg msg-${esc(m.outcome)}">
          <p class="msg-top"><strong>${esc(m.subject)}</strong><time>${when(m.timestamp)}</time></p>
          <p class="msg-body">${esc(m.body)}</p>
        </li>`).join("") : `<li class="empty">No notices yet.</li>`;
    } catch (err) { inboxEl.innerHTML = `<li class="empty">${esc(err.message)}</li>`; }
  }
  $("#refresh-btn").addEventListener("click", refreshSide);

  // --- boot ---------------------------------------------------------------------------
  showStep(0, false);
  DOC_TYPES.forEach(renderDoc);
  api("/api/samples").then((s) => { samples = s; }).catch(() => { samples = []; });
  refreshSide().catch(() => {});
})();
