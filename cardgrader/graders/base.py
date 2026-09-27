"""Helpers shared by the company graders."""

from __future__ import annotations

from ..condition import FLAWLESS, ComponentCondition, describe, fatal_defects
from ..models import CardAssessment, CompanyGrade

ALTERED_LABELS = {
    "PSA": "AUTHENTIC ALTERED",
    "BGS": "Authentic Altered",
    "CGC": "Altered",
    "TAG": "Altered",
}


def altered_grade(company: str, assessment: CardAssessment) -> CompanyGrade | None:
    fatal = fatal_defects(assessment)
    if not fatal:
        return None
    return CompanyGrade(
        company=company,  # type: ignore[arg-type]
        grade=0,
        label=ALTERED_LABELS[company],
        tier=99,
        limiting_factors=[f"{describe(d)}: altered cards get no numeric grade" for d in fatal],
    )


def fmt_grade(value: float) -> str:
    if value >= FLAWLESS:
        return "10 (Pristine)"
    return f"{value:g}"


def binding_factors(
    overall: float,
    parts: dict[str, float],
    centering_reasons: list[str],
    conditions: dict[str, ComponentCondition],
    slack: float = 0.0,
) -> list[str]:
    """Explain which parts hold the overall grade where it is."""
    factors: list[str] = []
    for name, value in sorted(parts.items(), key=lambda kv: kv[1]):
        if value > overall + slack:
            continue
        if name == "centering":
            detail = "; ".join(centering_reasons) or "centering"
            factors.append(f"Centering {fmt_grade(value)}: {detail}")
        else:
            cond = conditions.get(name)
            detail = "; ".join(cond.reasons) if cond and cond.reasons else ""
            factors.append(f"{name.capitalize()} {fmt_grade(value)}" + (f": {detail}" if detail else ""))
    return factors
