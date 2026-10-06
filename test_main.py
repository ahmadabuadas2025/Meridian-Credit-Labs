"""Tests for the Meridian Credit Labs loan-review demo. Run: python -m unittest -v"""
import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from loan_review import extraction, intake, pipeline, risk, rules
from loan_review.store import Store

SAMPLES = {s["scenario"]: s for s in pipeline.load_samples()}


def sample(name, **overrides):
    return {**copy.deepcopy(SAMPLES[name]), **overrides}


class EngineTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = Store(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def submit(self, payload):
        return pipeline.submit_application(self.store, payload)


class DecisionRuleTests(EngineTestCase):
    def test_complete_low_risk_is_approved(self):
        result = self.submit(sample("Complete + low risk"))
        decision = result["auto_decision"]
        self.assertEqual(decision["outcome"], "APPROVE")
        self.assertLess(decision["risk_score"], rules.THRESHOLDS["review_risk_score"])
        self.assertEqual(decision["decided_by"], "rules-engine")
        self.assertEqual(decision["rules_fired"][-1]["id"], "R7")

    def test_missing_proof_of_income_goes_to_review(self):
        decision = self.submit(sample("Missing income doc"))["auto_decision"]
        self.assertEqual(decision["outcome"], "REVIEW")
        self.assertIn("proof of income", decision["reason"])
        self.assertEqual(decision["missing_items"], ["proof of income"])
        self.assertEqual([r["id"] for r in decision["rules_fired"]], ["R1"])

    def test_high_risk_is_declined(self):
        decision = self.submit(sample("High risk"))["auto_decision"]
        self.assertEqual(decision["outcome"], "DECLINE")
        self.assertGreaterEqual(decision["risk_score"], 70)
        self.assertEqual(decision["rules_fired"][-1]["id"], "R2")

    def test_dti_too_high_is_declined(self):
        decision = self.submit(sample("DTI too high"))["auto_decision"]
        self.assertEqual(decision["outcome"], "DECLINE")
        self.assertGreater(decision["dti"], 0.45)
        self.assertEqual(decision["rules_fired"][-1]["id"], "R3")

    def test_income_mismatch_goes_to_review(self):
        decision = self.submit(sample("Income mismatch"))["auto_decision"]
        self.assertEqual(decision["outcome"], "REVIEW")
        self.assertIn("Income mismatch: stated $7,000 vs document $5,200", decision["reason"])
        self.assertEqual(decision["rules_fired"][-1]["id"], "R4")

    def test_borderline_risk_and_large_loan_go_to_review(self):
        self.assertEqual(self.submit(sample("Borderline risk"))["auto_decision"]["rules_fired"][-1]["id"], "R5")
        self.assertEqual(self.submit(sample("Large loan vs income"))["auto_decision"]["rules_fired"][-1]["id"], "R6")

    def test_rules_are_evaluated_in_order(self):
        # Missing documents (R1) is checked before high risk (R2), so this is REVIEW not DECLINE.
        payload = sample("High risk")
        payload["documents"] = payload["documents"][:1]
        decision = self.submit(payload)["auto_decision"]
        self.assertEqual(decision["outcome"], "REVIEW")
        self.assertIn("proof of income", decision["reason"])
        self.assertIn("bank statement", decision["reason"])


class IntakeTests(EngineTestCase):
    def test_negative_amount_raises_value_error(self):
        with self.assertRaises(ValueError):
            intake.normalize_application(sample("Complete + low risk", loan_amount=-500))

    def test_other_invalid_inputs_raise_value_error(self):
        for bad in ({"loan_amount": "lots"}, {"applicant_name": "  "}, {"term_months": 18},
                    {"credit_band": "platinum"}, {"stated_monthly_income": 0}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                intake.normalize_application(sample("Complete + low risk", **bad))

    def test_invalid_input_stores_nothing(self):
        with self.assertRaises(ValueError):
            self.submit(sample("Complete + low risk", loan_amount=-1))
        self.assertEqual(self.store.list_applications(), [])
        self.assertEqual(self.store.events(), [])


class ExtractionAndRiskTests(unittest.TestCase):
    def test_extracts_employer_and_income_from_pay_stub(self):
        app = intake.normalize_application(sample("Complete + low risk"))
        fields = extraction.extract_fields(app)
        self.assertEqual(fields.employer, "Harborlight Robotics Co.")
        self.assertEqual(fields.monthly_income, 6500.0)
        self.assertEqual(fields.id_name, "Avery Quill")
        self.assertEqual(fields.sources["monthly_income"], "pay_stub_avery.txt")

    def test_annual_salary_fallback(self):
        app = intake.normalize_application(sample("Complete + low risk"))
        app.document("proof_of_income").text = "Employer: Example Co\nAnnual Salary: $60,000"
        self.assertEqual(extraction.extract_fields(app).monthly_income, 5000.0)

    def test_risk_score_is_deterministic_and_clamped(self):
        app = intake.normalize_application(sample("High risk", prior_delinquencies=9))
        first, second = risk.score_risk(app), risk.score_risk(app)
        self.assertEqual(first, second)
        self.assertEqual(first.score, 100)


class UnderwritingTests(EngineTestCase):
    def test_underwriter_decision_is_new_event_and_preserves_auto_decision(self):
        app_id = self.submit(sample("Income mismatch"))["id"]
        before = self.store.get_application(app_id)
        detail = pipeline.review_application(self.store, app_id, "Reviewer One", "APPROVE",
                                             "Second pay stub confirms income.")
        self.assertEqual(detail["status"], "APPROVE")
        self.assertEqual(detail["auto_decision"]["outcome"], "REVIEW")  # original preserved
        self.assertEqual(self.store.get_application(app_id), before)    # record never rewritten
        events = [e["event"] for e in detail["audit_trail"]]
        self.assertEqual(events[-2:], ["UNDERWRITER_DECISION", "NOTIFIED"])
        uw = detail["audit_trail"][-2]
        self.assertEqual(uw["actor"], "Reviewer One")
        self.assertEqual(uw["details"]["decided_by"], "Reviewer One")

    def test_underwriter_decision_rejected_on_non_review_case(self):
        app_id = self.submit(sample("Complete + low risk"))["id"]
        with self.assertRaises(ValueError):
            pipeline.review_application(self.store, app_id, "Reviewer One", "DECLINE", "Changed my mind.")
        self.assertNotIn("UNDERWRITER_DECISION", [e["event"] for e in self.store.events(app_id)])

    def test_underwriter_requires_name_note_and_single_decision(self):
        app_id = self.submit(sample("Borderline risk"))["id"]
        with self.assertRaises(ValueError):
            pipeline.review_application(self.store, app_id, "", "APPROVE", "Looks fine to me.")
        with self.assertRaises(ValueError):
            pipeline.review_application(self.store, app_id, "Reviewer One", "APPROVE", "")
        pipeline.review_application(self.store, app_id, "Reviewer One", "DECLINE", "Too many recent late payments.")
        with self.assertRaises(ValueError):
            pipeline.review_application(self.store, app_id, "Reviewer Two", "APPROVE", "Overriding.")


class StoreTests(EngineTestCase):
    def test_round_trip(self):
        app_id = self.submit(sample("Complete + low risk"))["id"]
        saved = self.store.get_application(app_id)
        reloaded = Store(self._tmp.name).get_application(app_id)
        self.assertEqual(saved, reloaded)
        self.assertEqual(json.loads(json.dumps(saved)), reloaded)

    def test_audit_log_has_every_stage(self):
        app_id = self.submit(sample("Missing income doc"))["id"]
        events = [e["event"] for e in self.store.events(app_id)]
        self.assertEqual(events, ["SUBMITTED", "DOCS_EXTRACTED", "RISK_SCORED", "RULES_APPLIED",
                                  "ROUTED_TO_REVIEW", "NOTIFIED"])
        for e in self.store.events(app_id):
            self.assertTrue({"timestamp", "actor", "details"} <= e.keys())

    def test_records_are_write_once(self):
        record = self.store.get_application(self.submit(sample("Complete + low risk"))["id"])
        with self.assertRaises(ValueError):
            self.store.save_application(record)

    def test_notification_written_to_outbox(self):
        app_id = self.submit(sample("Complete + low risk"))["id"]
        messages = self.store.read_jsonl(self.store.outbox_path)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["app_id"], app_id)
        self.assertEqual(messages[0]["channel"], "mock-email")


class ApiSmokeTest(EngineTestCase):
    def setUp(self):
        super().setUp()
        from loan_review.server import make_server
        self.server = make_server(self.store, "127.0.0.1", 0, quiet=True)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_post_then_get(self):
        status, created = self.call("POST", "/api/applications", sample("Complete + low risk"))
        self.assertEqual(status, 201)
        self.assertEqual(created["auto_decision"]["outcome"], "APPROVE")
        status, fetched = self.call("GET", f"/api/applications/{created['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(fetched["id"], created["id"])
        self.assertEqual(len(fetched["audit_trail"]), 5)

    def test_errors_are_json_without_traceback(self):
        status, body = self.call("POST", "/api/applications", sample("Complete + low risk", loan_amount=-5))
        self.assertEqual(status, 400)
        self.assertIn("negative", body["error"])
        status, body = self.call("GET", "/api/applications/MCL-9999")
        self.assertEqual(status, 404)
        self.assertNotIn("Traceback", json.dumps(body))

    def test_static_index_is_served(self):
        with urllib.request.urlopen(self.base + "/", timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn(b"Meridian", resp.read())


if __name__ == "__main__":
    unittest.main()
