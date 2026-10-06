"""Human underwriting. The underwriter adds a decision; the automated one is never overwritten.

Rules:
  * only applications whose automated outcome is REVIEW can be decided;
  * each application can be decided once;
  * reviewer name and a note are required; outcome must be APPROVE or DECLINE.
"""
from __future__ import annotations

from .models import Decision


def underwriter_event(events: list[dict]) -> dict | None:
    return next((e for e in events if e["event"] == "UNDERWRITER_DECISION"), None)


def current_status(record: dict, events: list[dict]) -> str:
    """REVIEW cases show PENDING_REVIEW until a human decides; otherwise the latest outcome."""
    uw = underwriter_event(events)
    if uw:
        return uw["details"]["outcome"]
    auto = record["auto_decision"]["outcome"]
    return "PENDING_REVIEW" if auto == "REVIEW" else auto


def record_underwriter_decision(record: dict, events: list[dict], reviewer: str,
                                outcome: str, note: str) -> Decision:
    reviewer = " ".join(str(reviewer or "").split())
    note = str(note or "").strip()
    outcome = str(outcome or "").strip().upper()
    if record["auto_decision"]["outcome"] != "REVIEW":
        raise ValueError("Only applications routed to REVIEW can receive an underwriter decision.")
    if underwriter_event(events):
        raise ValueError("This application already has an underwriter decision.")
    if not reviewer:
        raise ValueError("Reviewer name is required.")
    if outcome not in ("APPROVE", "DECLINE"):
        raise ValueError("Underwriter outcome must be APPROVE or DECLINE.")
    if len(note) < 5:
        raise ValueError("A note explaining the decision is required (at least 5 characters).")
    if len(reviewer) > 80 or len(note) > 2000:
        raise ValueError("Reviewer name or note is too long.")

    auto = record["auto_decision"]
    return Decision(
        outcome=outcome,
        reason=f"Underwriter {outcome.lower()}d after review: {note}",
        rules_fired=auto["rules_fired"],  # the evidence the human reviewed
        risk_score=auto["risk_score"],
        dti=auto["dti"],
        decided_by=reviewer,
        note=note,
    )
