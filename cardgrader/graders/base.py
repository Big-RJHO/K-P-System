"""Helpers shared by the company graders.

Every grader starts with ``prepare`` (unread centering counts as 55/45) and ends with ``finish``, which
marks the grade incomplete when an area wasn't assessed. An incomplete grade keeps the numbers the card
would get if every unassessed area were perfect (a ceiling), labelled "Up to <label> · incomplete", with
``tier=None``. Both are this project's conventions, not rules published by PSA, Beckett, CGC or TAG.
"""

from __future__ import annotations

from ..centering import graded_centering
from ..condition import FLAWLESS, ComponentCondition, describe, fatal_defects, unassessed_areas, unread_centering_note
from ..models import CardAssessment, CompanyGrade

INCOMPLETE_NOTE = (
    "\"Up to ... · incomplete\" is this lab's own convention for a card that hasn't been fully checked, "
    "not a label any grading company uses."
)

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


def prepare(assessment: CardAssessment) -> CardAssessment:
    """The assessment as graded: each unread centering axis counts as at least 55/45."""
    return assessment.model_copy(update={"centering": graded_centering(assessment)})


def shown_subgrades(parts: dict[str, float], conditions: dict[str, ComponentCondition]) -> dict[str, float | None]:
    """Subgrades to report: None for a component that wasn't assessed (its value is only a ceiling)."""
    return {k: None if k in conditions and conditions[k].grade is None else v for k, v in parts.items()}


def finish(grade: CompanyGrade, assessment: CardAssessment) -> CompanyGrade:
    """Add the unread-centering note, and turn the grade into a ceiling if anything wasn't assessed."""
    if note := unread_centering_note(assessment):
        grade.notes.insert(0, note)
    missing = unassessed_areas(assessment)
    if not missing:
        return grade
    grade.complete = False
    grade.unassessed = missing
    grade.label = f"Up to {grade.label} · incomplete"
    grade.tier = None  # not an earned label, so it can't rank against real grades
    grade.limiting_factors.insert(
        0, f"Not assessed yet: {', '.join(missing)}. Until then this is the best case, not a grade."
    )
    grade.notes.append(INCOMPLETE_NOTE)
    return grade


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
