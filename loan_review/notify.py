"""MOCK notifications: messages are appended to data/outbox.jsonl. No email is sent."""
from __future__ import annotations

import uuid

from .models import Decision, utc_now
from .store import Store

NEXT_STEPS = {
    "APPROVE": "Your (mock) offer is ready to review. This demo stops here: no funds are disbursed.",
    "DECLINE": "You can reapply after 30 days or contact us with updated documents.",
    "REVIEW": "An underwriter will review your application. You will get another notice once they decide.",
}

SUBJECTS = {
    "APPROVE": "Your application {id} is approved",
    "DECLINE": "An update on your application {id}",
    "REVIEW": "Your application {id} is being reviewed",
}


def send_decision_notice(store: Store, app_id: str, applicant_name: str, email: str, decision: Decision) -> dict:
    who = "an underwriter" if decision.decided_by != "rules-engine" else "our automated rules"
    message = {
        "message_id": uuid.uuid4().hex[:12],
        "app_id": app_id,
        "channel": "mock-email",
        "to": email,
        "subject": SUBJECTS[decision.outcome].format(id=app_id),
        "body": (f"Hi {applicant_name.split()[0]}, a decision was made by {who}: {decision.outcome}. "
                 f"Reason: {decision.reason} Next: {NEXT_STEPS[decision.outcome]}"),
        "outcome": decision.outcome,
        "timestamp": utc_now(),
    }
    store.append_jsonl(store.outbox_path, message)
    return message


def outbox(store: Store, app_ids: set[str] | None = None) -> list[dict]:
    messages = store.read_jsonl(store.outbox_path)
    return [m for m in messages if app_ids is None or m["app_id"] in app_ids]
