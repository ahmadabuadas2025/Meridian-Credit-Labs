"""Plain dataclasses shared by every component. No business logic lives here."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

REQUIRED_DOCUMENTS = ("government_id", "proof_of_income", "bank_statement")
DOCUMENT_LABELS = {
    "government_id": "government ID",
    "proof_of_income": "proof of income",
    "bank_statement": "bank statement",
}
VALID_TERMS = (12, 24, 36, 48, 60)
CREDIT_BANDS = ("excellent", "good", "fair", "poor", "very_poor")  # MOCK bands, no bureau
LOAN_PURPOSES = (
    "debt_consolidation", "home_improvement", "auto", "education",
    "medical", "business", "other",
)
OUTCOMES = ("APPROVE", "DECLINE", "REVIEW")


def utc_now() -> str:
    """ISO-8601 UTC timestamp, second precision, e.g. 2026-09-26T14:03:11Z."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class Document:
    type: str       # one of REQUIRED_DOCUMENTS
    filename: str
    text: str       # plain-text content (the browser reads .txt uploads with FileReader)


@dataclass
class Application:
    applicant_name: str
    email: str
    loan_amount: float
    term_months: int
    purpose: str
    stated_monthly_income: float
    monthly_debts: float
    years_employed: float
    credit_band: str
    prior_delinquencies: int = 0
    documents: list[Document] = field(default_factory=list)

    @property
    def document_types(self) -> set[str]:
        return {d.type for d in self.documents}

    def document(self, doc_type: str) -> Document | None:
        return next((d for d in self.documents if d.type == doc_type), None)

    def to_dict(self, include_text: bool = False) -> dict:
        data = asdict(self)
        if not include_text:
            for doc in data["documents"]:
                doc["chars"] = len(doc.pop("text"))
        return data


@dataclass
class ExtractedFields:
    employer: str | None = None
    monthly_income: float | None = None
    id_name: str | None = None
    bank_avg_monthly_deposits: float | None = None
    sources: dict[str, str] = field(default_factory=dict)  # field name -> filename it came from
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RiskResult:
    score: int                      # 0-100, higher = riskier
    dti: float                      # fraction, e.g. 0.31 = 31%
    estimated_payment: float        # est. monthly payment on the new loan
    components: dict[str, float]    # each term of the formula, for explainability

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Decision:
    outcome: str                    # APPROVE | DECLINE | REVIEW
    reason: str                     # plain English
    rules_fired: list[dict]         # evaluation trace: [{id, name, fired, values}]
    risk_score: int
    dti: float
    decided_by: str                 # "rules-engine" or the underwriter's name
    timestamp: str = field(default_factory=utc_now)
    missing_items: list[str] = field(default_factory=list)
    note: str = ""                  # underwriter note (empty for automated decisions)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class AuditEvent:
    app_id: str
    event: str                      # SUBMITTED, DOCS_EXTRACTED, RISK_SCORED, ...
    actor: str
    details: dict
    timestamp: str = field(default_factory=utc_now)

    def to_dict(self) -> dict:
        return asdict(self)
