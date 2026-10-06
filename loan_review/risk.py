"""MOCK risk score, 0-100 (higher = riskier). Deterministic and fully explainable.

    risk = band_points[credit_band]
         + 40 * min(DTI, 1.0)
         + 12 * prior_delinquencies
         -  2 * min(years_employed, 5)
    clamped to 0..100 and rounded to a whole number.

    band_points: excellent 5, good 15, fair 30, poor 50, very_poor 65
    DTI = (monthly_debts + estimated new payment) / stated monthly income
    estimated new payment = standard amortised payment at a MOCK 9.9% APR

This is a teaching toy, not a credit model. The credit band is self-reported
and fictional; no bureau is contacted.
"""
from __future__ import annotations

from .models import Application, RiskResult

MOCK_APR = 0.099
BAND_POINTS = {"excellent": 5, "good": 15, "fair": 30, "poor": 50, "very_poor": 65}
DTI_WEIGHT = 40
DELINQUENCY_POINTS = 12
EMPLOYMENT_CREDIT_PER_YEAR = 2
EMPLOYMENT_YEARS_CAP = 5


def estimated_payment(amount: float, term_months: int, apr: float = MOCK_APR) -> float:
    r = apr / 12
    return round(amount * r / (1 - (1 + r) ** -term_months), 2)


def score_risk(app: Application) -> RiskResult:
    payment = estimated_payment(app.loan_amount, app.term_months)
    dti = (app.monthly_debts + payment) / app.stated_monthly_income
    components = {
        "credit_band": BAND_POINTS[app.credit_band],
        "dti": round(DTI_WEIGHT * min(dti, 1.0), 1),
        "delinquencies": DELINQUENCY_POINTS * app.prior_delinquencies,
        "employment": -round(EMPLOYMENT_CREDIT_PER_YEAR * min(app.years_employed, EMPLOYMENT_YEARS_CAP), 1),
    }
    score = max(0, min(100, round(sum(components.values()))))
    return RiskResult(score=score, dti=round(dti, 4), estimated_payment=payment, components=components)
