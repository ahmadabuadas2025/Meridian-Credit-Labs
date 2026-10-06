"""TOY lending rules. Evaluated in this exact order; the first rule that fires decides.

  R0  Invalid input                                  -> ValueError (raised in intake.py)
  R1  Any required document missing                  -> REVIEW  "Missing: proof of income"
  R2  Mock risk score >= 70                          -> DECLINE
  R3  DTI (debts + est. new payment) / income > 45%  -> DECLINE
  R4  Document income differs from stated by > 15%   -> REVIEW  "Income mismatch: stated $X vs document $Y"
      (also fires if no income could be read from the proof of income)
  R5  Mock risk score 40-69                          -> REVIEW  borderline, routed to underwriter
  R6  Loan amount > 50% of annual stated income      -> REVIEW
  R7  Otherwise                                      -> APPROVE

Every rule that was evaluated is recorded in `rules_fired` with the values it
used, so a reviewer can see exactly why the engine stopped where it did.
"""
from __future__ import annotations

from .models import (DOCUMENT_LABELS, REQUIRED_DOCUMENTS, Application, Decision,
                     ExtractedFields, RiskResult)

THRESHOLDS = {
    "decline_risk_score": 70,           # R2: risk >= this -> DECLINE
    "max_dti": 0.45,                    # R3: DTI above this -> DECLINE
    "income_mismatch_tolerance": 0.15,  # R4: |doc - stated| / stated above this -> REVIEW
    "review_risk_score": 40,            # R5: risk >= this (and < decline) -> REVIEW
    "max_loan_to_annual_income": 0.50,  # R6: loan / (12 * income) above this -> REVIEW
}

RULE_NAMES = {
    "R1": "Required documents present",
    "R2": "Risk score below decline threshold",
    "R3": "Debt-to-income within limit",
    "R4": "Document income matches stated income",
    "R5": "Risk score below review threshold",
    "R6": "Loan size within 50% of annual income",
    "R7": "All checks passed",
}


def _usd(x: float) -> str:
    return f"${x:,.0f}"


def evaluate(app: Application, extracted: ExtractedFields, risk: RiskResult) -> Decision:
    t = THRESHOLDS
    trace: list[dict] = []

    def fired(rule_id: str, condition: bool, **values) -> bool:
        trace.append({"id": rule_id, "name": RULE_NAMES[rule_id], "fired": bool(condition), "values": values})
        return bool(condition)

    def decide(outcome: str, reason: str, missing: list[str] | None = None) -> Decision:
        return Decision(outcome=outcome, reason=reason, rules_fired=trace, risk_score=risk.score,
                        dti=risk.dti, decided_by="rules-engine", missing_items=missing or [])

    missing = [DOCUMENT_LABELS[d] for d in REQUIRED_DOCUMENTS if d not in app.document_types]
    if fired("R1", missing, missing=missing, required=[DOCUMENT_LABELS[d] for d in REQUIRED_DOCUMENTS]):
        return decide("REVIEW", "Missing: " + ", ".join(missing), missing)

    if fired("R2", risk.score >= t["decline_risk_score"], risk_score=risk.score, threshold=t["decline_risk_score"]):
        return decide("DECLINE", f"Mock risk score {risk.score} is at or above the decline threshold of "
                                 f"{t['decline_risk_score']}.")

    if fired("R3", risk.dti > t["max_dti"], dti=risk.dti, max_dti=t["max_dti"],
             monthly_debts=app.monthly_debts, estimated_payment=risk.estimated_payment,
             monthly_income=app.stated_monthly_income):
        return decide("DECLINE", f"Debt-to-income ratio {risk.dti:.1%} exceeds the {t['max_dti']:.0%} maximum "
                                 f"(debts {_usd(app.monthly_debts)} + est. payment {_usd(risk.estimated_payment)} "
                                 f"on income {_usd(app.stated_monthly_income)}/mo).")

    stated, doc_income = app.stated_monthly_income, extracted.monthly_income
    if doc_income is None:
        fired("R4", True, stated=stated, document=None, difference=None, tolerance=t["income_mismatch_tolerance"])
        return decide("REVIEW", "Income could not be verified: no income figure found in the proof of income.")
    diff = abs(doc_income - stated) / stated
    if fired("R4", diff > t["income_mismatch_tolerance"], stated=stated, document=doc_income,
             difference=round(diff, 4), tolerance=t["income_mismatch_tolerance"]):
        return decide("REVIEW", f"Income mismatch: stated {_usd(stated)} vs document {_usd(doc_income)} "
                                f"({diff:.1%} difference).")

    if fired("R5", risk.score >= t["review_risk_score"], risk_score=risk.score,
             review_range=[t["review_risk_score"], t["decline_risk_score"] - 1]):
        return decide("REVIEW", f"Borderline mock risk score {risk.score} ({t['review_risk_score']}-"
                                f"{t['decline_risk_score'] - 1}); routed to an underwriter.")

    annual = stated * 12
    ratio = app.loan_amount / annual
    if fired("R6", ratio > t["max_loan_to_annual_income"], loan_amount=app.loan_amount,
             annual_income=annual, ratio=round(ratio, 4), max_ratio=t["max_loan_to_annual_income"]):
        return decide("REVIEW", f"Loan amount {_usd(app.loan_amount)} is more than "
                                f"{t['max_loan_to_annual_income']:.0%} of annual income ({_usd(annual)}); "
                                f"routed to an underwriter.")

    fired("R7", True, risk_score=risk.score, dti=risk.dti, income_difference=round(diff, 4))
    return decide("APPROVE", f"All checks passed: documents complete, income verified, "
                             f"mock risk {risk.score}, DTI {risk.dti:.1%}.")
