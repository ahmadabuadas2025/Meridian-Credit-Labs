import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "meridian-credit-labs";
const SAMPLE_DIR = process.env.NETLIFY
  ? path.join(process.cwd(), "sample_data")
  : fileURLToPath(new URL("../../sample_data", import.meta.url));
const REQUIRED_DOCUMENTS = ["government_id", "proof_of_income", "bank_statement"];
const DOCUMENT_LABELS = {
  government_id: "government ID",
  proof_of_income: "proof of income",
  bank_statement: "bank statement",
};
const VALID_TERMS = [12, 24, 36, 48, 60];
const LOAN_PURPOSES = [
  "debt_consolidation", "home_improvement", "auto", "education", "medical", "business", "other",
];
const CREDIT_BANDS = ["excellent", "good", "fair", "poor", "very_poor"];
const BAND_POINTS = { excellent: 5, good: 15, fair: 30, poor: 50, very_poor: 65 };
const RULE_NAMES = {
  R1: "Required documents present",
  R2: "Risk score below decline threshold",
  R3: "Debt-to-income within limit",
  R4: "Document income matches stated income",
  R5: "Risk score below review threshold",
  R6: "Loan size within 50% of annual income",
  R7: "All checks passed",
};
const COMPONENTS = [
  ["Intake", ["SUBMITTED"]],
  ["Extraction", ["DOCS_EXTRACTED"]],
  ["Risk", ["RISK_SCORED"]],
  ["Rules", ["RULES_APPLIED", "ROUTED_TO_REVIEW"]],
  ["Underwriting", ["UNDERWRITER_DECISION"]],
  ["Store", null],
  ["Notify", ["NOTIFIED"]],
];
const NEXT_STEPS = {
  APPROVE: "Your (mock) offer is ready to review. This demo stops here: no funds are disbursed.",
  DECLINE: "You can reapply after 30 days or contact us with updated documents.",
  REVIEW: "An underwriter will review your application. You will get another notice once they decide.",
};
const SUBJECTS = {
  APPROVE: "Your application {id} is approved",
  DECLINE: "An update on your application {id}",
  REVIEW: "Your application {id} is being reviewed",
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function usd(value) {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function event(appId, kind, actor, details, timestamp = now()) {
  return { app_id: appId, event: kind, actor, details, timestamp };
}

function applicationEventsKey(id, index) {
  return `events/${id}/${String(index).padStart(4, "0")}`;
}

async function saveEvent(store, id, index, value, onlyIfNew = false) {
  const result = await store.setJSON(applicationEventsKey(id, index), value, { onlyIfNew });
  return result.modified;
}

async function listBlobs(store, prefix) {
  const blobs = [];
  for await (const page of store.list({ prefix, paginate: true })) blobs.push(...page.blobs);
  return blobs.sort((a, b) => a.key.localeCompare(b.key));
}

async function readEvents(store, id) {
  const keys = await listBlobs(store, `events/${id}/`);
  const events = await Promise.all(keys.map(({ key }) => store.get(key, { type: "json" })));
  return events.filter(Boolean);
}

async function readAllEvents(store) {
  const keys = await listBlobs(store, "events/");
  const events = await Promise.all(keys.map(({ key }) => store.get(key, { type: "json" })));
  return events.filter(Boolean).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function number(payload, key, label, { positive = false, defaultValue } = {}) {
  const raw = payload[key] ?? defaultValue;
  if (raw == null || (typeof raw === "string" && !raw.trim())) {
    throw new ApiError(400, `${label} is required.`);
  }
  if (typeof raw === "boolean") throw new ApiError(400, `${label} must be a number.`);
  const value = Number(String(raw).replace(/,/g, "").replace(/\$/g, "").trim());
  if (!Number.isFinite(value)) throw new ApiError(400, `${label} must be a number.`);
  if (value < 0) throw new ApiError(400, `${label} cannot be negative.`);
  if (positive && value === 0) throw new ApiError(400, `${label} must be greater than zero.`);
  return value;
}

function choice(raw, allowed, label) {
  const value = String(raw || "").trim().toLowerCase().replace(/[ -]/g, "_");
  if (!allowed.includes(value)) throw new ApiError(400, `${label} must be one of: ${allowed.join(", ")}.`);
  return value;
}

function normalizeApplication(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "Application must be a JSON object.");
  }
  const name = String(payload.applicant_name || "").trim().replace(/\s+/g, " ");
  if (!name) throw new ApiError(400, "Applicant name is required.");
  if (name.length > 100) throw new ApiError(400, "Applicant name is too long.");
  const email = String(payload.email || "").trim();
  if (!email.includes("@") || /\s/.test(email) || email.length > 120) {
    throw new ApiError(400, "A valid (fictional) email is required.");
  }

  const amount = number(payload, "loan_amount", "Loan amount", { positive: true });
  const term = number(payload, "term_months", "Term", { positive: true });
  if (!VALID_TERMS.includes(term)) {
    throw new ApiError(400, `Term must be one of ${VALID_TERMS.join(", ")} months.`);
  }
  const delinquencies = number(payload, "prior_delinquencies", "Prior delinquencies", { defaultValue: 0 });
  if (!Number.isInteger(delinquencies)) throw new ApiError(400, "Prior delinquencies must be a whole number.");

  const rawDocuments = payload.documents ?? [];
  if (!Array.isArray(rawDocuments)) throw new ApiError(400, "Documents must be a list.");
  const documents = new Map();
  for (const item of rawDocuments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(400, "Each document must be an object with type, filename and text.");
    }
    const type = choice(item.type, REQUIRED_DOCUMENTS, "Document type");
    if (typeof item.text !== "string" || !item.text.trim()) {
      throw new ApiError(400, `The ${type.replaceAll("_", " ")} document is empty.`);
    }
    if (item.text.length > 50_000) throw new ApiError(400, `The ${type.replaceAll("_", " ")} document is too large.`);
    const filename = path.basename(String(item.filename || `${type}.txt`).replace(/\\/g, "/")).slice(0, 120);
    documents.set(type, { type, filename, text: item.text });
  }

  return {
    applicant_name: name,
    email,
    loan_amount: Math.round(amount * 100) / 100,
    term_months: term,
    purpose: choice(payload.purpose || "other", LOAN_PURPOSES, "Loan purpose"),
    stated_monthly_income: Math.round(number(payload, "stated_monthly_income", "Stated monthly income", { positive: true }) * 100) / 100,
    monthly_debts: Math.round(number(payload, "monthly_debts", "Monthly debts") * 100) / 100,
    years_employed: number(payload, "years_employed", "Years employed"),
    credit_band: choice(payload.credit_band, CREDIT_BANDS, "Credit band"),
    prior_delinquencies: delinquencies,
    documents: [...documents.values()],
  };
}

function extractFields(app) {
  const out = { employer: null, monthly_income: null, id_name: null, bank_avg_monthly_deposits: null, sources: {}, notes: [] };
  const money = (match) => match ? Number(match[1].replace(/,/g, "")) : null;
  const proof = app.documents.find((doc) => doc.type === "proof_of_income");
  if (proof) {
    const employer = proof.text.match(/^\s*employer(?:\s+name)?\s*[:\-]\s*([^\r\n]+?)\s*$/im);
    if (employer) {
      out.employer = employer[1];
      out.sources.employer = proof.filename;
    }
    let income = money(proof.text.match(/(?:gross\s+monthly\s+(?:income|pay)|monthly\s+gross\s+(?:income|pay)|monthly\s+income)\s*[:\-]\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i));
    if (income == null) {
      const annual = money(proof.text.match(/annual\s+(?:gross\s+)?(?:salary|income)\s*[:\-]\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i));
      if (annual != null) {
        income = Math.round(annual / 12 * 100) / 100;
        out.notes.push("Monthly income derived from annual salary / 12.");
      }
    }
    if (income != null) {
      out.monthly_income = income;
      out.sources.monthly_income = proof.filename;
    } else {
      out.notes.push("No income figure found in proof of income.");
    }
  }
  const id = app.documents.find((doc) => doc.type === "government_id");
  const idName = id?.text.match(/^\s*(?:full\s+)?name\s*[:\-]\s*([^\r\n]+?)\s*$/im);
  if (idName) {
    out.id_name = idName[1];
    out.sources.id_name = id.filename;
  }
  const bank = app.documents.find((doc) => doc.type === "bank_statement");
  const deposits = bank && money(bank.text.match(/average\s+monthly\s+deposits?\s*[:\-]\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i));
  if (deposits != null) {
    out.bank_avg_monthly_deposits = deposits;
    out.sources.bank_avg_monthly_deposits = bank.filename;
  }
  return out;
}

function evaluate(app, extracted, risk) {
  const trace = [];
  const fired = (id, condition, values) => {
    trace.push({ id, name: RULE_NAMES[id], fired: Boolean(condition), values });
    return Boolean(condition);
  };
  const decide = (outcome, reason, missing = []) => ({
    outcome, reason, rules_fired: trace, risk_score: risk.score, dti: risk.dti,
    decided_by: "rules-engine", timestamp: now(), missing_items: missing, note: "",
  });

  const missing = REQUIRED_DOCUMENTS.filter((type) => !app.documents.some((doc) => doc.type === type))
    .map((type) => DOCUMENT_LABELS[type]);
  if (fired("R1", missing.length > 0, { missing, required: REQUIRED_DOCUMENTS.map((type) => DOCUMENT_LABELS[type]) })) {
    return decide("REVIEW", `Missing: ${missing.join(", ")}`, missing);
  }
  if (fired("R2", risk.score >= 70, { risk_score: risk.score, threshold: 70 })) {
    return decide("DECLINE", `Mock risk score ${risk.score} is at or above the decline threshold of 70.`);
  }
  if (fired("R3", risk.dti > 0.45, {
    dti: risk.dti, max_dti: 0.45, monthly_debts: app.monthly_debts,
    estimated_payment: risk.estimated_payment, monthly_income: app.stated_monthly_income,
  })) {
    return decide("DECLINE", `Debt-to-income ratio ${(risk.dti * 100).toFixed(1)}% exceeds the 45% maximum `
      + `(debts ${usd(app.monthly_debts)} + est. payment ${usd(risk.estimated_payment)} `
      + `on income ${usd(app.stated_monthly_income)}/mo).`);
  }
  const stated = app.stated_monthly_income;
  const docIncome = extracted.monthly_income;
  if (docIncome == null) {
    fired("R4", true, { stated, document: null, difference: null, tolerance: 0.15 });
    return decide("REVIEW", "Income could not be verified: no income figure found in the proof of income.");
  }
  const diff = Math.abs(docIncome - stated) / stated;
  if (fired("R4", diff > 0.15, { stated, document: docIncome, difference: Math.round(diff * 10_000) / 10_000, tolerance: 0.15 })) {
    return decide("REVIEW", `Income mismatch: stated ${usd(stated)} vs document ${usd(docIncome)} (${(diff * 100).toFixed(1)}% difference).`);
  }
  if (fired("R5", risk.score >= 40, { risk_score: risk.score, review_range: [40, 69] })) {
    return decide("REVIEW", `Borderline mock risk score ${risk.score} (40-69); routed to an underwriter.`);
  }
  const annual = stated * 12;
  const ratio = app.loan_amount / annual;
  if (fired("R6", ratio > 0.5, { loan_amount: app.loan_amount, annual_income: annual, ratio: Math.round(ratio * 10_000) / 10_000, max_ratio: 0.5 })) {
    return decide("REVIEW", `Loan amount ${usd(app.loan_amount)} is more than 50% of annual income (${usd(annual)}); routed to an underwriter.`);
  }
  fired("R7", true, { risk_score: risk.score, dti: risk.dti, income_difference: Math.round(diff * 10_000) / 10_000 });
  return decide("APPROVE", `All checks passed: documents complete, income verified, mock risk ${risk.score}, DTI ${(risk.dti * 100).toFixed(1)}%.`);
}

function scoreRisk(app) {
  const monthlyRate = 0.099 / 12;
  const payment = Math.round((app.loan_amount * monthlyRate / (1 - (1 + monthlyRate) ** -app.term_months)) * 100) / 100;
  const dti = (app.monthly_debts + payment) / app.stated_monthly_income;
  const components = {
    credit_band: BAND_POINTS[app.credit_band],
    dti: Math.round(40 * Math.min(dti, 1) * 10) / 10,
    delinquencies: 12 * app.prior_delinquencies,
    employment: -Math.round(2 * Math.min(app.years_employed, 5) * 10) / 10,
  };
  const score = Math.max(0, Math.min(100, Math.round(Object.values(components).reduce((sum, value) => sum + value, 0))));
  return { score, dti: Math.round(dti * 10_000) / 10_000, estimated_payment: payment, components };
}

function applicationRecord(app, extracted, risk, decision, id, scenario) {
  return {
    id,
    submitted_at: decision.timestamp,
    scenario: String(scenario || "").slice(0, 60),
    application: {
      ...app,
      documents: app.documents.map(({ type, filename, text }) => ({ type, filename, chars: text.length })),
    },
    extracted,
    risk,
    auto_decision: decision,
  };
}

function makeNotice(id, app, decision, messageId = null) {
  const who = decision.decided_by !== "rules-engine" ? "an underwriter" : "our automated rules";
  return {
    message_id: messageId || crypto.randomUUID().replaceAll("-", "").slice(0, 12),
    app_id: id,
    channel: "mock-email",
    to: app.email,
    subject: SUBJECTS[decision.outcome].replace("{id}", id),
    body: `Hi ${app.applicant_name.split(/\s+/)[0]}, a decision was made by ${who}: ${decision.outcome}. `
      + `Reason: ${decision.reason} Next: ${NEXT_STEPS[decision.outcome]}`,
    outcome: decision.outcome,
    timestamp: now(),
  };
}

async function appendNotice(store, id, app, decision, sequence, stable = false) {
  const notice = makeNotice(id, app, decision, stable ? `seed-${id}` : null);
  await store.setJSON(`outbox/${notice.message_id}`, notice, { onlyIfNew: true });
  await saveEvent(store, id, sequence, event(id, "NOTIFIED", "notify (mock)", {
    message_id: notice.message_id, to: notice.to, outcome: decision.outcome,
  }, notice.timestamp), true);
}

async function saveInitialState(store, record, stableNotice = false) {
  const { id, application: app, extracted, risk, auto_decision: decision } = record;
  const events = [
    event(id, "SUBMITTED", "applicant", {
      amount: app.loan_amount, term_months: app.term_months,
      documents: app.documents.map((doc) => doc.type).sort(),
    }, record.submitted_at),
    event(id, "DOCS_EXTRACTED", "extraction (mock)", {
      employer: extracted.employer, monthly_income: extracted.monthly_income,
      id_name: extracted.id_name, notes: extracted.notes,
    }),
    event(id, "RISK_SCORED", "risk (mock)", { score: risk.score, dti: risk.dti, components: risk.components }),
    event(id, "RULES_APPLIED", "rules-engine", {
      outcome: decision.outcome, reason: decision.reason, rules: decision.rules_fired.map((rule) => rule.id),
    }),
  ];
  if (decision.outcome === "REVIEW") {
    events.push(event(id, "ROUTED_TO_REVIEW", "rules-engine", { queue: "underwriting", reason: decision.reason }));
  }
  for (const [index, item] of events.entries()) await saveEvent(store, id, index, item, true);
  await appendNotice(store, id, app, decision, events.length, stableNotice);
  return getDetail(store, id);
}

async function submitApplication(store, payload) {
  const app = normalizeApplication(payload);
  const extracted = extractFields(app);
  const risk = scoreRisk(app);
  const decision = evaluate(app, extracted, risk);
  const id = `MCL-${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const record = applicationRecord(app, extracted, risk, decision, id, payload.scenario);
  const created = await store.setJSON(`applications/${id}`, record, { onlyIfNew: true });
  if (!created.modified) throw new ApiError(409, "Application ID collision. Please submit again.");
  return saveInitialState(store, record);
}

function withStatus(record, events) {
  const underwriter = events.find((item) => item.event === "UNDERWRITER_DECISION");
  const status = underwriter ? underwriter.details.outcome
    : record.auto_decision.outcome === "REVIEW" ? "PENDING_REVIEW" : record.auto_decision.outcome;
  return {
    ...record,
    status,
    underwriter_decision: underwriter ? underwriter.details : null,
    final_decision: underwriter ? underwriter.details : record.auto_decision,
  };
}

async function getDetail(store, id) {
  const record = await store.get(`applications/${id}`, { type: "json" });
  if (!record) return null;
  const events = await readEvents(store, id);
  return { ...withStatus(record, events), audit_trail: events };
}

async function listSummaries(store) {
  const keys = await listBlobs(store, "applications/");
  const records = await Promise.all(keys.map(({ key }) => store.get(key, { type: "json" })));
  const allEvents = await readAllEvents(store);
  const byApp = new Map();
  for (const item of allEvents) {
    const list = byApp.get(item.app_id) || [];
    list.push(item);
    byApp.set(item.app_id, list);
  }
  return records.filter(Boolean).map((record) => {
    const full = withStatus(record, byApp.get(record.id) || []);
    const app = full.application;
    return {
      id: full.id, submitted_at: full.submitted_at, scenario: full.scenario,
      applicant_name: app.applicant_name, loan_amount: app.loan_amount, term_months: app.term_months,
      purpose: app.purpose, risk_score: full.risk.score, dti: full.risk.dti,
      auto_outcome: full.auto_decision.outcome, status: full.status,
      reason: full.final_decision.reason, decided_by: full.final_decision.decided_by,
    };
  }).sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
}

async function stats(store) {
  const apps = await listSummaries(store);
  const counts = { APPROVE: 0, DECLINE: 0, PENDING_REVIEW: 0 };
  for (const app of apps) counts[app.status] = (counts[app.status] || 0) + 1;
  const events = await readAllEvents(store);
  const components = COMPONENTS.map(([name, kinds]) => {
    const last = [...events].reverse().find((item) => !kinds || kinds.includes(item.event)) || null;
    return { name, last_event: last, status: last ? "ok" : "idle" };
  });
  return {
    total: apps.length,
    approved: counts.APPROVE,
    declined: counts.DECLINE,
    in_review: counts.PENDING_REVIEW,
    auto_review_total: apps.filter((app) => app.auto_outcome === "REVIEW").length,
    avg_risk: apps.length ? Math.round(apps.reduce((sum, app) => sum + app.risk_score, 0) / apps.length * 10) / 10 : 0,
    components,
    event_count: events.length,
  };
}

async function loadSamples() {
  const samples = JSON.parse(await readFile(path.join(SAMPLE_DIR, "applications.json"), "utf8"));
  for (const sample of samples) {
    for (const doc of sample.documents || []) {
      doc.text = await readFile(path.join(SAMPLE_DIR, "docs", doc.filename), "utf8");
    }
  }
  return samples;
}

async function seedSamples(store) {
  const samples = await loadSamples();
  for (const [index, sample] of samples.entries()) {
    const id = `MCL-${1001 + index}`;
    const existing = await store.get(`applications/${id}`, { type: "json" });
    if (existing) {
      await saveInitialState(store, existing, true);
      continue;
    }
    const app = normalizeApplication(sample);
    const extracted = extractFields(app);
    const risk = scoreRisk(app);
    const decision = evaluate(app, extracted, risk);
    const candidate = applicationRecord(app, extracted, risk, decision, id, sample.scenario);
    const created = await store.setJSON(`applications/${id}`, candidate, { onlyIfNew: true });
    const record = created.modified ? candidate : await store.get(`applications/${id}`, { type: "json" });
    await saveInitialState(store, record, true);
  }
  return samples;
}

async function reviewApplication(store, id, body) {
  const record = await store.get(`applications/${id}`, { type: "json" });
  if (!record) throw new ApiError(404, `Application ${id} not found.`);
  const events = await readEvents(store, id);
  const existingDecision = events.find((item) => item.event === "UNDERWRITER_DECISION");
  if (record.auto_decision.outcome !== "REVIEW") {
    throw new ApiError(400, "Only applications routed to REVIEW can receive an underwriter decision.");
  }
  if (existingDecision) throw new ApiError(400, "This application already has an underwriter decision.");
  const reviewer = String(body.reviewer || "").trim().replace(/\s+/g, " ");
  const note = String(body.note || "").trim();
  const outcome = String(body.outcome || "").trim().toUpperCase();
  if (!reviewer) throw new ApiError(400, "Reviewer name is required.");
  if (!["APPROVE", "DECLINE"].includes(outcome)) {
    throw new ApiError(400, "Underwriter outcome must be APPROVE or DECLINE.");
  }
  if (note.length < 5) throw new ApiError(400, "A note explaining the decision is required (at least 5 characters).");
  if (reviewer.length > 80 || note.length > 2000) throw new ApiError(400, "Reviewer name or note is too long.");

  const decision = {
    outcome,
    reason: `Underwriter ${outcome.toLowerCase()}d after review: ${note}`,
    rules_fired: record.auto_decision.rules_fired,
    risk_score: record.auto_decision.risk_score,
    dti: record.auto_decision.dti,
    decided_by: reviewer,
    timestamp: now(),
    missing_items: [],
    note,
  };
  const decisionEvent = event(id, "UNDERWRITER_DECISION", reviewer, decision, decision.timestamp);
  const saved = await saveEvent(store, id, events.length, decisionEvent, true);
  if (!saved) throw new ApiError(409, "This application already has an underwriter decision.");
  await appendNotice(store, id, record.application, decision, events.length + 1);
  return getDetail(store, id);
}

async function route(request, store) {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === "GET" && url.pathname === "/api/samples") return { status: 200, body: await loadSamples() };
  await seedSamples(store);

  if (method === "GET" && url.pathname === "/api/stats") return { status: 200, body: await stats(store) };
  if (method === "GET" && url.pathname === "/api/applications") {
    return { status: 200, body: await listSummaries(store) };
  }
  if (method === "GET" && url.pathname === "/api/outbox") {
    const ids = new Set((url.searchParams.get("ids") || "").split(",").filter(Boolean));
    const keys = await listBlobs(store, "outbox/");
    const messages = await Promise.all(keys.map(({ key }) => store.get(key, { type: "json" })));
    return { status: 200, body: messages.filter((item) => item && (!ids.size || ids.has(item.app_id)))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp)) };
  }
  if (method === "GET" && segments.length === 3 && segments[1] === "applications") {
    const detail = await getDetail(store, segments[2]);
    if (!detail) throw new ApiError(404, `Application ${segments[2]} not found.`);
    return { status: 200, body: detail };
  }
  if (method === "POST" && url.pathname === "/api/applications") {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 1_000_000) throw new ApiError(413, "Request body too large (max 1 MB).");
    let body;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "Request body must be valid JSON.");
    }
    return { status: 201, body: await submitApplication(store, body) };
  }
  if (method === "POST" && url.pathname === "/api/reset") {
    throw new ApiError(403, "Reset is disabled for shared hosted data.");
  }
  if (method === "POST" && segments.length === 4 && segments[1] === "applications" && segments[3] === "review") {
    let body;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "Request body must be valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "Request body must be a JSON object.");
    }
    return { status: 200, body: await reviewApplication(store, segments[2], body) };
  }
  throw new ApiError(404, "Not found.");
}

export async function handleRequest(request, store) {
  try {
    const result = await route(request, store);
    return Response.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, {
        status: error.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    console.error("Netlify API request failed:", error);
    return Response.json({ error: "Internal server error." }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export default async function handler(request) {
  return handleRequest(request, getStore(STORE_NAME, { consistency: "strong" }));
}

export const config = { path: "/api/*" };
