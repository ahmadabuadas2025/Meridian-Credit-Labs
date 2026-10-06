"""MOCK "Document AI": regex extraction over plain-text documents.

A real system would run OCR plus a trained model. Here we look for labelled
lines such as "Employer: ..." and "Gross Monthly Income: $6,500.00".

  proof_of_income -> employer, monthly_income (falls back to annual salary / 12)
  government_id   -> id_name
  bank_statement  -> bank_avg_monthly_deposits
"""
from __future__ import annotations

import re

from .models import Application, ExtractedFields

_MONEY = r"\$?\s*(?P<v>[0-9][0-9,]*(?:\.[0-9]{1,2})?)"
_LINE = r"\s*[:\-]\s*(?P<v>[^\r\n]+?)\s*$"

EMPLOYER = re.compile(r"^\s*employer(?:\s+name)?" + _LINE, re.I | re.M)
MONTHLY_INCOME = re.compile(
    r"(?:gross\s+monthly\s+(?:income|pay)|monthly\s+gross\s+(?:income|pay)|monthly\s+income)\s*[:\-]\s*" + _MONEY,
    re.I,
)
ANNUAL_INCOME = re.compile(r"annual\s+(?:gross\s+)?(?:salary|income)\s*[:\-]\s*" + _MONEY, re.I)
ID_NAME = re.compile(r"^\s*(?:full\s+)?name" + _LINE, re.I | re.M)
BANK_DEPOSITS = re.compile(r"average\s+monthly\s+deposits?\s*[:\-]\s*" + _MONEY, re.I)


def _money(match: re.Match | None) -> float | None:
    return float(match.group("v").replace(",", "")) if match else None


def extract_fields(app: Application) -> ExtractedFields:
    out = ExtractedFields()

    stub = app.document("proof_of_income")
    if stub:
        if m := EMPLOYER.search(stub.text):
            out.employer = m.group("v")
            out.sources["employer"] = stub.filename
        income = _money(MONTHLY_INCOME.search(stub.text))
        if income is None and (annual := _money(ANNUAL_INCOME.search(stub.text))) is not None:
            income = round(annual / 12, 2)
            out.notes.append("Monthly income derived from annual salary / 12.")
        if income is not None:
            out.monthly_income = income
            out.sources["monthly_income"] = stub.filename
        else:
            out.notes.append("No income figure found in proof of income.")

    gov_id = app.document("government_id")
    if gov_id and (m := ID_NAME.search(gov_id.text)):
        out.id_name = m.group("v")
        out.sources["id_name"] = gov_id.filename

    bank = app.document("bank_statement")
    if bank and (deposits := _money(BANK_DEPOSITS.search(bank.text))) is not None:
        out.bank_avg_monthly_deposits = deposits
        out.sources["bank_avg_monthly_deposits"] = bank.filename

    return out
