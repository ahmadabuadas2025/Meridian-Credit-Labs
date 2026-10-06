"""Orchestration only: wires the components together and writes the audit trail.

intake -> extraction -> risk -> rules -> (human review) -> decision record -> notification
"""
from __future__ import annotations

import json
from pathlib import Path

from . import extraction, intake, notify, risk, rules, underwriting
from .models import AuditEvent
from .store import Store

SAMPLE_DIR = Path(__file__).resolve().parent.parent / "sample_data"


def submit_application(store: Store, payload: dict) -> dict:
    """Run the automated pipeline. Raises ValueError on invalid input (nothing is stored)."""
    app = intake.normalize_application(payload)          # R0
    extracted = extraction.extract_fields(app)
    risk_result = risk.score_risk(app)
    decision = rules.evaluate(app, extracted, risk_result)

    with store.lock:
        app_id = store.next_id()
        store.save_application({
            "id": app_id,
            "submitted_at": decision.timestamp,
            "scenario": str(payload.get("scenario") or "")[:60],
            "application": app.to_dict(),
            "extracted": extracted.to_dict(),
            "risk": risk_result.to_dict(),
            "auto_decision": decision.to_dict(),
        })
        log = lambda event, actor, **details: store.append_event(AuditEvent(app_id, event, actor, details))
        log("SUBMITTED", "applicant", amount=app.loan_amount, term_months=app.term_months,
            documents=sorted(app.document_types))
        log("DOCS_EXTRACTED", "extraction (mock)", employer=extracted.employer,
            monthly_income=extracted.monthly_income, id_name=extracted.id_name, notes=extracted.notes)
        log("RISK_SCORED", "risk (mock)", score=risk_result.score, dti=risk_result.dti,
            components=risk_result.components)
        log("RULES_APPLIED", "rules-engine", outcome=decision.outcome, reason=decision.reason,
            rules=[r["id"] for r in decision.rules_fired])
        if decision.outcome == "REVIEW":
            log("ROUTED_TO_REVIEW", "rules-engine", queue="underwriting", reason=decision.reason)
        msg = notify.send_decision_notice(store, app_id, app.applicant_name, app.email, decision)
        log("NOTIFIED", "notify (mock)", message_id=msg["message_id"], to=msg["to"], outcome=decision.outcome)
    return get_detail(store, app_id)


def review_application(store: Store, app_id: str, reviewer: str, outcome: str, note: str) -> dict:
    """Record a human decision as a new event. Raises KeyError (unknown id) or ValueError."""
    with store.lock:
        record = store.get_application(app_id)
        if record is None:
            raise KeyError(app_id)
        decision = underwriting.record_underwriter_decision(record, store.events(app_id), reviewer, outcome, note)
        store.append_event(AuditEvent(app_id, "UNDERWRITER_DECISION", decision.decided_by, decision.to_dict()))
        app = record["application"]
        msg = notify.send_decision_notice(store, app_id, app["applicant_name"], app["email"], decision)
        store.append_event(AuditEvent(app_id, "NOTIFIED", "notify (mock)", {
            "message_id": msg["message_id"], "to": msg["to"], "outcome": decision.outcome}))
    return get_detail(store, app_id)


def _with_status(record: dict, events: list[dict]) -> dict:
    uw = underwriting.underwriter_event(events)
    return {
        **record,
        "status": underwriting.current_status(record, events),
        "underwriter_decision": uw["details"] if uw else None,
        "final_decision": uw["details"] if uw else record["auto_decision"],
    }


def get_detail(store: Store, app_id: str) -> dict | None:
    record = store.get_application(app_id)
    if record is None:
        return None
    events = store.events(app_id)
    return {**_with_status(record, events), "audit_trail": events}


def list_summaries(store: Store) -> list[dict]:
    by_app: dict[str, list[dict]] = {}
    for e in store.events():
        by_app.setdefault(e["app_id"], []).append(e)
    out = []
    for record in store.list_applications():
        full = _with_status(record, by_app.get(record["id"], []))
        a = full["application"]
        out.append({
            "id": full["id"], "submitted_at": full["submitted_at"], "scenario": full["scenario"],
            "applicant_name": a["applicant_name"], "loan_amount": a["loan_amount"],
            "term_months": a["term_months"], "purpose": a["purpose"],
            "risk_score": full["risk"]["score"], "dti": full["risk"]["dti"],
            "auto_outcome": full["auto_decision"]["outcome"], "status": full["status"],
            "reason": full["final_decision"]["reason"], "decided_by": full["final_decision"]["decided_by"],
        })
    return out


COMPONENTS = [  # (module, events it produces)
    ("Intake", ["SUBMITTED"]),
    ("Extraction", ["DOCS_EXTRACTED"]),
    ("Risk", ["RISK_SCORED"]),
    ("Rules", ["RULES_APPLIED", "ROUTED_TO_REVIEW"]),
    ("Underwriting", ["UNDERWRITER_DECISION"]),
    ("Store", None),  # every event is a store write
    ("Notify", ["NOTIFIED"]),
]


def stats(store: Store) -> dict:
    apps = list_summaries(store)
    counts = {k: 0 for k in ("APPROVE", "DECLINE", "PENDING_REVIEW")}
    for a in apps:
        counts[a["status"]] = counts.get(a["status"], 0) + 1
    events = store.events()
    components = []
    for name, kinds in COMPONENTS:
        last = next((e for e in reversed(events) if kinds is None or e["event"] in kinds), None)
        components.append({"name": name, "last_event": last, "status": "ok" if last else "idle"})
    return {
        "total": len(apps),
        "approved": counts["APPROVE"],
        "declined": counts["DECLINE"],
        "in_review": counts["PENDING_REVIEW"],
        "auto_review_total": sum(1 for a in apps if a["auto_outcome"] == "REVIEW"),
        "avg_risk": round(sum(a["risk_score"] for a in apps) / len(apps), 1) if apps else 0,
        "components": components,
        "event_count": len(events),
    }


def load_samples(sample_dir: Path = SAMPLE_DIR) -> list[dict]:
    """Sample applicants with document text inlined from sample_data/docs/."""
    with open(sample_dir / "applications.json", encoding="utf-8") as f:
        samples = json.load(f)
    for sample in samples:
        for doc in sample.get("documents", []):
            doc["text"] = (sample_dir / "docs" / doc["filename"]).read_text(encoding="utf-8")
    return samples


def seed_samples(store: Store, sample_dir: Path = SAMPLE_DIR) -> list[dict]:
    store.reset()
    return [submit_application(store, s) for s in load_samples(sample_dir)]
