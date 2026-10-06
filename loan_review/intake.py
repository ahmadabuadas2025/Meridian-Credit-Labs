"""Intake: validate and normalise raw application input (rule R0).

Anything invalid raises ValueError with a message that is safe to show an
applicant. Nothing is stored until intake succeeds.
"""
from __future__ import annotations

import math
import os

from .models import (CREDIT_BANDS, LOAN_PURPOSES, REQUIRED_DOCUMENTS, VALID_TERMS,
                     Application, Document)

MAX_TEXT_CHARS = 50_000
MAX_NAME_CHARS = 100


def _number(payload: dict, key: str, label: str, *, positive: bool = False, default=None) -> float:
    raw = payload.get(key, default)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        raise ValueError(f"{label} is required.")
    if isinstance(raw, bool):
        raise ValueError(f"{label} must be a number.")
    try:
        value = float(str(raw).replace(",", "").replace("$", "").strip())
    except ValueError:
        raise ValueError(f"{label} must be a number.") from None
    if not math.isfinite(value):
        raise ValueError(f"{label} must be a number.")
    if value < 0:
        raise ValueError(f"{label} cannot be negative.")
    if positive and value == 0:
        raise ValueError(f"{label} must be greater than zero.")
    return value


def _choice(raw, allowed, label: str) -> str:
    value = str(raw or "").strip().lower().replace(" ", "_").replace("-", "_")
    if value not in allowed:
        raise ValueError(f"{label} must be one of: {', '.join(allowed)}.")
    return value


def _documents(raw) -> list[Document]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("Documents must be a list.")
    docs: dict[str, Document] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Each document must be an object with type, filename and text.")
        doc_type = _choice(item.get("type"), REQUIRED_DOCUMENTS, "Document type")
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"The {doc_type.replace('_', ' ')} document is empty.")
        if len(text) > MAX_TEXT_CHARS:
            raise ValueError(f"The {doc_type.replace('_', ' ')} document is too large.")
        filename = os.path.basename(str(item.get("filename") or f"{doc_type}.txt"))[:120]
        docs[doc_type] = Document(type=doc_type, filename=filename, text=text)  # last one wins
    return list(docs.values())


def normalize_application(payload: dict) -> Application:
    """Validate raw input (e.g. JSON from the browser) and return an Application."""
    if not isinstance(payload, dict):
        raise ValueError("Application must be a JSON object.")

    name = " ".join(str(payload.get("applicant_name") or "").split())
    if not name:
        raise ValueError("Applicant name is required.")
    if len(name) > MAX_NAME_CHARS:
        raise ValueError("Applicant name is too long.")

    email = str(payload.get("email") or "").strip()
    if "@" not in email or " " in email or len(email) > 120:
        raise ValueError("A valid (fictional) email is required.")

    amount = _number(payload, "loan_amount", "Loan amount", positive=True)

    term_raw = _number(payload, "term_months", "Term", positive=True)
    if term_raw not in VALID_TERMS:
        raise ValueError(f"Term must be one of {', '.join(map(str, VALID_TERMS))} months.")

    delinquencies = _number(payload, "prior_delinquencies", "Prior delinquencies", default=0)
    if delinquencies != int(delinquencies):
        raise ValueError("Prior delinquencies must be a whole number.")

    return Application(
        applicant_name=name,
        email=email,
        loan_amount=round(amount, 2),
        term_months=int(term_raw),
        purpose=_choice(payload.get("purpose") or "other", LOAN_PURPOSES, "Loan purpose"),
        stated_monthly_income=round(_number(payload, "stated_monthly_income", "Stated monthly income", positive=True), 2),
        monthly_debts=round(_number(payload, "monthly_debts", "Monthly debts"), 2),
        years_employed=_number(payload, "years_employed", "Years employed"),
        credit_band=_choice(payload.get("credit_band"), CREDIT_BANDS, "Credit band"),
        prior_delinquencies=int(delinquencies),
        documents=_documents(payload.get("documents")),
    )
