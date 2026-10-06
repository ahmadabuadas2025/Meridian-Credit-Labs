/* Underwriter console: KPIs, outcome chart, component status, queue table, detail drawer. */
(function () {
  "use strict";
  const { api, escapeHtml: esc, usd, pct, pill, when, toast } = window.MCL;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  let apps = [];
  let filter = "PENDING_REVIEW";
  let sort = { key: "risk_score", dir: -1 };
  let lastFocus = null;

  function alertPage(msg) { $("#page-alert").textContent = msg || ""; }

  // --- data ---------------------------------------------------------------------------
  async function load() {
    try {
      const [stats, list] = await Promise.all([api("/api/stats"), api("/api/applications")]);
      apps = list;
      alertPage("");
      renderKpis(stats);
      renderChart(stats);
      renderComponents(stats.components);
      renderRows();
    } catch (err) { alertPage(err.message); }
  }

  function renderKpis(s) {
    $("#k-total").textContent = s.total;
    $("#k-approved").textContent = s.approved;
    $("#k-declined").textContent = s.declined;
    $("#k-review").textContent = s.in_review;
    $("#k-risk").textContent = s.avg_risk.toFixed(1);
  }

  // Horizontal bars, one per outcome. Order approve -> review -> decline (validated adjacency).
  function renderChart(s) {
    const rows = [["Approved", s.approved, "approve"], ["In review", s.in_review, "review"], ["Declined", s.declined, "decline"]];
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const W = 420, rowH = 44, labelW = 96, valueW = 36, barMax = W - labelW - valueW - 8;
    const bars = rows.map(([label, n, key], i) => {
      const y = i * rowH;
      const w = n ? Math.max(6, (n / max) * barMax) : 0;
      const share = s.total ? Math.round((n / s.total) * 100) : 0;
      return `<g class="bar-row">
        <title>${label}: ${n} of ${s.total} (${share}%)</title>
        <rect x="0" y="${y}" width="${W}" height="${rowH - 4}" fill="transparent"/>
        <text x="0" y="${y + rowH / 2 + 3}" class="bar-label">${label}</text>
        <rect x="${labelW}" y="${y + 12}" width="${barMax}" height="16" rx="4" class="bar-track"/>
        ${w ? `<rect x="${labelW}" y="${y + 12}" width="${w.toFixed(1)}" height="16" rx="4" class="bar bar-${key}"/>` : ""}
        <text x="${W}" y="${y + rowH / 2 + 3}" text-anchor="end" class="bar-value">${n}</text>
      </g>`;
    }).join("");
    $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${rows.length * rowH}" role="img" aria-label="Outcomes: ${rows.map((r) => `${r[0]} ${r[1]}`).join(", ")}">${bars}</svg>
      <p class="chart-note muted small">${s.auto_review_total} of ${s.total} applications were routed to review by the rules; ${s.auto_review_total - s.in_review} have been decided by an underwriter.</p>`;
  }

  const COMPONENT_FILE = { Intake: "intake.py", Extraction: "extraction.py", Risk: "risk.py", Rules: "rules.py",
    Underwriting: "underwriting.py", Store: "store.py", Notify: "notify.py" };

  function renderComponents(list) {
    $("#components").innerHTML = list.map((c) => {
      const e = c.last_event;
      return `<li class="component">
        <span class="status-dot ${c.status === "ok" ? "on" : ""}" aria-hidden="true"></span>
        <div class="comp-main"><p class="comp-name">${esc(c.name)} <code>${COMPONENT_FILE[c.name] || ""}</code></p>
          <p class="comp-event">${e ? `${esc(e.event)} on ${esc(e.app_id)}, ${when(e.timestamp)}` : "No events yet"}</p></div>
        <span class="visually-hidden">${c.status === "ok" ? "Active" : "Idle"}</span>
      </li>`;
    }).join("");
  }

  // --- table --------------------------------------------------------------------------
  function visibleApps() {
    const q = $("#search").value.trim().toLowerCase();
    return apps
      .filter((a) => filter === "ALL" || a.status === filter)
      .filter((a) => !q || a.applicant_name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const x = a[sort.key], y = b[sort.key];
        return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
      });
  }

  function renderRows() {
    const rows = visibleApps();
    $$("[data-filter]").forEach((b) => {
      const n = b.dataset.filter === "ALL" ? apps.length : apps.filter((a) => a.status === b.dataset.filter).length;
      b.innerHTML = `${b.dataset.label || (b.dataset.label = b.textContent)} <span class="count">${n}</span>`;
    });
    $("#rows").innerHTML = rows.length ? rows.map((a) => `
      <tr data-id="${esc(a.id)}">
        <td><button type="button" class="row-open num" data-open="${esc(a.id)}">${esc(a.id)}</button></td>
        <td>${esc(a.applicant_name)}</td>
        <td class="r num">${usd(a.loan_amount)}</td>
        <td class="r num"><span class="risk risk-${a.risk_score >= 70 ? "hi" : a.risk_score >= 40 ? "mid" : "lo"}">${a.risk_score}</span></td>
        <td class="r num">${pct(a.dti)}</td>
        <td>${pill(a.status)}</td>
        <td class="reason-col"><span class="reason">${esc(a.reason)}</span></td>
      </tr>`).join("")
      : `<tr><td colspan="7" class="empty-row">${filter === "PENDING_REVIEW" ? "The review queue is empty. Every case has a decision." : "No applications match."}</td></tr>`;
  }

  $("#rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openDrawer(tr.dataset.id, tr.querySelector(".row-open"));
  });
  $$("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.filter;
    $$("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderRows();
  }));
  $("#search").addEventListener("input", renderRows);
  $$("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.sort;
    sort = { key, dir: sort.key === key ? -sort.dir : (["risk_score", "dti", "loan_amount"].includes(key) ? -1 : 1) };
    $$("th[aria-sort]").forEach((th) => th.setAttribute("aria-sort", "none"));
    b.closest("th").setAttribute("aria-sort", sort.dir === 1 ? "ascending" : "descending");
    renderRows();
  }));

  // --- drawer -------------------------------------------------------------------------
  function gauge(score) {
    const band = score >= 70 ? "decline" : score >= 40 ? "review" : "approve";
    const tick = (v) => { // threshold marks at 40 and 70
      const a = Math.PI * (1 - v / 100), r1 = 70, r2 = 92;
      return `<line x1="${100 + r1 * Math.cos(a)}" y1="${100 - r1 * Math.sin(a)}" x2="${100 + r2 * Math.cos(a)}" y2="${100 - r2 * Math.sin(a)}" class="g-tick"/>`;
    };
    return `<svg viewBox="0 0 200 112" class="gauge" role="img" aria-label="Mock risk score ${score} out of 100">
      <path d="M20 100 A80 80 0 0 1 180 100" pathLength="100" class="g-track"/>
      <path d="M20 100 A80 80 0 0 1 180 100" pathLength="100" class="g-value g-${band}" stroke-dasharray="${score} 100"/>
      ${tick(40)}${tick(70)}
      <text x="100" y="92" text-anchor="middle" class="g-score">${score}</text>
      <text x="100" y="110" text-anchor="middle" class="g-sub">of 100</text>
    </svg>`;
  }

  function compareRows(r) {
    const a = r.application, x = r.extracted;
    const diff = x.monthly_income != null ? Math.abs(x.monthly_income - a.stated_monthly_income) / a.stated_monthly_income : null;
    const nameMismatch = x.id_name && x.id_name.toLowerCase() !== a.applicant_name.toLowerCase();
    const row = (label, applicant, doc, flag, note) => `<tr class="${flag ? "flag" : ""}">
      <th scope="row">${label}</th><td>${applicant}</td><td>${doc}${flag ? `<span class="flag-note">${note}</span>` : ""}</td></tr>`;
    const none = '<span class="muted">Not found</span>';
    return `<table class="compare"><caption class="visually-hidden">Applicant input compared with document fields</caption>
      <thead><tr><th scope="col"><span class="visually-hidden">Field</span></th><th scope="col">Applicant said</th><th scope="col">Documents say</th></tr></thead>
      <tbody>
        ${row("Name", esc(a.applicant_name), x.id_name ? esc(x.id_name) : none, nameMismatch, "Doesn't match ID")}
        ${row("Monthly income", usd(a.stated_monthly_income), x.monthly_income != null ? usd(x.monthly_income) : none,
          diff == null || diff > 0.15, diff == null ? "Can't verify" : `${pct(diff)} apart`)}
        ${row("Employer", '<span class="muted">Not asked</span>', x.employer ? esc(x.employer) : none, false, "")}
        ${row("Avg. deposits", '<span class="muted">Not asked</span>', x.bank_avg_monthly_deposits != null ? usd(x.bank_avg_monthly_deposits) : none, false, "")}
      </tbody></table>
      <p class="doc-list muted small">Documents: ${a.documents.map((d) => esc(d.filename)).join(", ") || "none"}${x.notes.length ? `. ${esc(x.notes.join(" "))}` : ""}</p>`;
  }

  function fmtValue(k, v) {
    if (v == null) return "none";
    if (Array.isArray(v)) return v.length ? v.map(esc).join(", ") : "none";
    if (typeof v === "number") {
      if (/dti|ratio|difference|tolerance/.test(k)) return pct(v);
      if (/income|amount|debts|payment|stated|document/.test(k)) return usd(v);
    }
    return esc(v);
  }

  function rulesTrace(d) {
    const fired = d.rules_fired;
    const all = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];
    return `<ol class="trace-list">${all.map((id) => {
      const r = fired.find((x) => x.id === id);
      if (!r) return `<li class="t-skip"><span class="rid">${id}</span><span>Not reached</span></li>`;
      const vals = Object.entries(r.values).map(([k, v]) => `<span class="kv"><span>${esc(k.replace(/_/g, " "))}</span> ${fmtValue(k, v)}</span>`).join("");
      return `<li class="${r.fired ? "t-fired" : "t-pass"}"><span class="rid">${id}</span>
        <div><p class="t-name">${esc(r.name)} <span class="t-state">${r.id === "R7" ? "decides: approve" : r.fired ? "did not pass, decides" : "passed"}</span></p><p class="t-vals">${vals}</p></div></li>`;
    }).join("")}</ol>`;
  }

  function auditTimeline(events) {
    return `<ol class="audit-list">${events.map((e) => {
      const d = e.details || {};
      const detail = d.reason || d.note || (d.score != null ? `Score ${d.score}, DTI ${pct(d.dti)}` : "")
        || (d.to ? `To ${d.to}` : "") || (d.employer !== undefined ? `Employer: ${d.employer || "none"}, income: ${d.monthly_income != null ? usd(d.monthly_income) : "none"}` : "")
        || (d.amount != null ? `${usd(d.amount)}, documents: ${(d.documents || []).join(", ") || "none"}` : "");
      return `<li><time>${when(e.timestamp)}</time><div><p><b>${esc(e.event)}</b> <span class="muted">by ${esc(e.actor)}</span></p>${detail ? `<p class="small">${esc(detail)}</p>` : ""}</div></li>`;
    }).join("")}</ol>`;
  }

  function decisionBlock(label, d) {
    return `<div class="dec dec-${d.outcome}">
      <p class="dec-by">${label}: <strong>${esc(d.decided_by)}</strong>, ${when(d.timestamp)}</p>
      <p>${pill(d.outcome)} ${esc(d.reason)}</p></div>`;
  }

  function reviewForm(r) {
    if (r.status !== "PENDING_REVIEW") {
      return r.underwriter_decision ? "" : `<p class="muted small">Only applications the rules sent to review can be decided by an underwriter.</p>`;
    }
    return `<form class="review-form" id="review-form" novalidate>
      <div class="field"><label for="rv-name">Your name</label>
        <input class="input" id="rv-name" autocomplete="off" maxlength="80" aria-describedby="rv-name-err"><p class="error-msg" id="rv-name-err"></p></div>
      <div class="field"><label for="rv-note">Note for the record</label>
        <textarea class="input" id="rv-note" maxlength="2000" aria-describedby="rv-note-hint rv-note-err"></textarea>
        <p class="hint" id="rv-note-hint">Required. Say what you checked and why you decided this way.</p>
        <p class="error-msg" id="rv-note-err"></p></div>
      <p class="form-alert" id="rv-alert" role="alert"></p>
      <div class="review-actions">
        <button type="submit" class="btn btn-approve" value="APPROVE">Approve</button>
        <button type="submit" class="btn btn-decline" value="DECLINE">Decline</button>
      </div>
    </form>`;
  }

  function renderDrawer(r) {
    const a = r.application;
    $("#d-id").textContent = r.id + (r.scenario ? `, sample: ${r.scenario}` : "");
    $("#d-title").textContent = a.applicant_name;
    const c = r.risk.components;
    $("#d-body").innerHTML = `
      <div class="d-summary">
        <p class="num">${usd(a.loan_amount)} over ${a.term_months} months, ${esc(a.purpose.replace(/_/g, " "))}</p>
        ${pill(r.status)}
      </div>
      <section class="d-sec"><h3>Decisions</h3>
        ${decisionBlock("Automated", r.auto_decision)}
        ${r.underwriter_decision ? decisionBlock("Underwriter", r.underwriter_decision) : ""}
      </section>
      ${r.status === "PENDING_REVIEW" ? `<section class="d-sec d-action"><h3>Your decision</h3>${reviewForm(r)}</section>` : ""}
      <section class="d-sec"><h3>Applicant vs documents</h3>${compareRows(r)}</section>
      <section class="d-sec"><h3>Mock risk score</h3>
        <div class="risk-grid">${gauge(r.risk.score)}
          <dl class="formula num">
            <div><dt>Credit band (${esc(a.credit_band.replace("_", " "))})</dt><dd>+${c.credit_band}</dd></div>
            <div><dt>DTI ${pct(r.risk.dti)} &times; 40</dt><dd>+${c.dti}</dd></div>
            <div><dt>${a.prior_delinquencies} late payment${a.prior_delinquencies === 1 ? "" : "s"} &times; 12</dt><dd>+${c.delinquencies}</dd></div>
            <div><dt>${a.years_employed} yrs employed (max 5) &times; 2</dt><dd>${c.employment === 0 ? "0" : "&minus;" + Math.abs(c.employment)}</dd></div>
            <div class="total"><dt>Score (clamped 0 to 100)</dt><dd>${r.risk.score}</dd></div>
          </dl>
        </div>
        <p class="muted small">Est. payment ${usd(r.risk.estimated_payment)}/mo at a mock 9.9% APR. Review at 40, decline at 70.</p>
      </section>
      <section class="d-sec"><h3>Rules, in evaluation order</h3>${rulesTrace(r.auto_decision)}</section>
      <section class="d-sec"><h3>Audit trail</h3>${auditTimeline(r.audit_trail)}</section>`;

    const formEl = $("#review-form");
    if (formEl) formEl.addEventListener("submit", (e) => submitReview(e, r.id));
  }

  async function submitReview(e, id) {
    e.preventDefault();
    const outcome = (e.submitter && e.submitter.value) || "APPROVE";
    const name = $("#rv-name"), note = $("#rv-note");
    const nameErr = name.value.trim() ? "" : "Enter your name so the decision is attributed.";
    const noteErr = note.value.trim().length >= 5 ? "" : "Add a note of at least 5 characters.";
    $("#rv-name-err").textContent = nameErr; name.setAttribute("aria-invalid", String(!!nameErr));
    $("#rv-note-err").textContent = noteErr; note.setAttribute("aria-invalid", String(!!noteErr));
    if (nameErr || noteErr) { (nameErr ? name : note).focus(); return; }
    $$("#review-form button").forEach((b) => { b.disabled = true; });
    try {
      const r = await api(`/api/applications/${encodeURIComponent(id)}/review`, {
        method: "POST", body: { reviewer: name.value, outcome, note: note.value } });
      renderDrawer(r);
      $("#d-title").focus();
      toast(`${outcome === "APPROVE" ? "Approved" : "Declined"} ${id}. The applicant has been notified (mock).`);
      load();
    } catch (err) {
      $("#rv-alert").textContent = err.message;
      $$("#review-form button").forEach((b) => { b.disabled = false; });
    }
  }

  async function openDrawer(id, trigger) {
    lastFocus = trigger || document.activeElement;
    try {
      const r = await api(`/api/applications/${encodeURIComponent(id)}`);
      renderDrawer(r);
    } catch (err) { toast(err.message); return; }
    $("#backdrop").hidden = false;
    $("#drawer").hidden = false;
    document.body.classList.add("drawer-open");
    requestAnimationFrame(() => { $("#drawer").classList.add("open"); $("#backdrop").classList.add("open"); });
    $("#d-body").scrollTop = 0;
    $("#d-close").focus();
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
  }

  function closeDrawer() {
    if ($("#drawer").hidden) return;
    $("#drawer").classList.remove("open"); $("#backdrop").classList.remove("open");
    $("#drawer").hidden = true; $("#backdrop").hidden = true;
    document.body.classList.remove("drawer-open");
    history.replaceState(null, "", location.pathname);
    const back = lastFocus && document.contains(lastFocus) ? lastFocus : $(`[data-open]`);
    if (back) back.focus();
  }

  $("#d-close").addEventListener("click", closeDrawer);
  $("#backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if ($("#drawer").hidden) return;
    if (e.key === "Escape") { closeDrawer(); return; }
    if (e.key === "Tab") { // keep focus inside the dialog
      const f = $$("#drawer button, #drawer input, #drawer textarea, #drawer a[href], #drawer [tabindex='-1']")
        .filter((el) => !el.disabled && el.offsetParent !== null && el.tabIndex >= 0);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // --- actions ------------------------------------------------------------------------
  $("#refresh").addEventListener("click", () => { load(); toast("Refreshed."); });
  $("#reset").addEventListener("click", async () => {
    if (!window.confirm("Reset the demo? This deletes every application, audit event and notice, then reloads the 7 sample applicants.")) return;
    try {
      await api("/api/reset", { method: "POST" });
      closeDrawer();
      await load();
      toast("Demo data reset to the 7 sample applicants.");
    } catch (err) { alertPage(err.message); }
  });

  load().then(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (/^MCL-\d+$/.test(id)) openDrawer(id, null);
  });
})();
