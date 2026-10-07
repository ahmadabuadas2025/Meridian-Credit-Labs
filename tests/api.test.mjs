import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../netlify/functions/api.mjs";

class MemoryStore {
  values = new Map();

  async get(key) {
    const value = this.values.get(key);
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) return { modified: false };
    this.values.set(key, JSON.parse(JSON.stringify(value)));
    return { modified: true };
  }

  async *list({ prefix }) {
    const blobs = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key) => ({ key, etag: "test" }));
    yield { blobs, directories: [] };
  }
}

function request(path, { method = "GET", body } = {}) {
  return new Request(`https://demo.test${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("samples endpoint returns all seven scenarios with document text", async () => {
  const response = await handleRequest(request("/api/samples"), new MemoryStore());
  const samples = await response.json();

  assert.equal(response.status, 200);
  assert.equal(samples.length, 7);
  assert.match(samples[0].documents[0].text, /Avery Quill/);
});

test("hosted API seeds samples and returns populated stats and applications", async () => {
  const store = new MemoryStore();
  const statsResponse = await handleRequest(request("/api/stats"), store);
  const stats = await statsResponse.json();
  const appsResponse = await handleRequest(request("/api/applications"), store);
  const apps = await appsResponse.json();

  assert.equal(stats.total, 7);
  assert.equal(stats.approved, 1);
  assert.equal(stats.declined, 2);
  assert.equal(stats.in_review, 4);
  assert.equal(apps.length, 7);
  assert.deepEqual(apps.map((app) => app.status), [
    "APPROVE", "PENDING_REVIEW", "DECLINE", "DECLINE",
    "PENDING_REVIEW", "PENDING_REVIEW", "PENDING_REVIEW",
  ]);
});

test("concurrent first requests seed the shared sample set only once", async () => {
  const store = new MemoryStore();
  const [statsResponse, appsResponse] = await Promise.all([
    handleRequest(request("/api/stats"), store),
    handleRequest(request("/api/applications"), store),
  ]);

  assert.equal((await statsResponse.json()).total, 7);
  assert.equal((await appsResponse.json()).length, 7);
  assert.equal((await store.list({ prefix: "outbox/" }).next()).value.blobs.length, 7);
});

test("submission, detail lookup and underwriter review persist across requests", async () => {
  const store = new MemoryStore();
  await handleRequest(request("/api/stats"), store);
  const createdResponse = await handleRequest(request("/api/applications", {
    method: "POST",
    body: {
      scenario: "Test case",
      applicant_name: "Test Applicant",
      email: "test@example.com",
      loan_amount: 8000,
      term_months: 24,
      purpose: "home_improvement",
      stated_monthly_income: 5200,
      monthly_debts: 350,
      years_employed: 4,
      credit_band: "good",
      documents: [],
    },
  }), store);
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 201);
  assert.equal(created.status, "PENDING_REVIEW");
  assert.match(created.id, /^MCL-[A-Z0-9]+$/);
  const detailResponse = await handleRequest(request(`/api/applications/${created.id}`), store);
  const detail = await detailResponse.json();
  const outboxResponse = await handleRequest(request(`/api/outbox?ids=${created.id}`), store);
  const notices = await outboxResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.audit_trail.length, 6);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].app_id, created.id);

  const reviewRequest = (reviewer, outcome, note) => handleRequest(request(`/api/applications/${created.id}/review`, {
    method: "POST",
    body: { reviewer, outcome, note },
  }), store);
  const reviews = await Promise.all([
    reviewRequest("Reviewer One", "APPROVE", "Documents verified."),
    reviewRequest("Reviewer Two", "DECLINE", "Another decision."),
  ]);
  assert.equal(reviews.filter((response) => response.status === 200).length, 1);
  assert.ok(reviews.every((response) => [200, 400, 409].includes(response.status)));
  const successfulReview = reviews.find((response) => response.status === 200);
  const reviewed = await successfulReview.json();
  const repeatedResponse = await reviewRequest("Reviewer Three", "APPROVE", "Review again.");

  assert.ok(["APPROVE", "DECLINE"].includes(reviewed.status));
  assert.equal(reviewed.auto_decision.outcome, "REVIEW");
  assert.equal(reviewed.audit_trail.at(-2).event, "UNDERWRITER_DECISION");
  assert.equal(repeatedResponse.status, 400);
});

test("hosted reset is rejected without modifying shared data", async () => {
  const store = new MemoryStore();
  const before = await handleRequest(request("/api/stats"), store);
  const reset = await handleRequest(request("/api/reset", { method: "POST" }), store);
  const after = await handleRequest(request("/api/stats"), store);

  assert.equal(reset.status, 403);
  assert.equal((await before.json()).total, (await after.json()).total);
});
