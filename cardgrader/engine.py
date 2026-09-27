"""Run every company grader over one assessment."""

from __future__ import annotations

from .graders import GRADERS
from .models import CardAssessment, GradeReport

DISCLAIMER = (
    "Theoretical estimate built from each company's published grading standards. "
    "Not affiliated with or endorsed by PSA, Beckett, CGC or TAG. Real grades depend on "
    "each company's inspection and can differ."
)


def grade_all(assessment: CardAssessment) -> GradeReport:
    grades = {name: fn(assessment) for name, fn in GRADERS.items()}
    # Best fit: the company where the card lands closest to that company's top label.
    # Ties go to dict order (PSA, BGS, CGC, TAG).
    best = min(grades.values(), key=lambda g: g.tier)
    if best.tier >= 99:
        summary = "The card appears altered, so no company will give it a numeric grade."
    else:
        summary = f"Best fit: {best.company} {best.label}. " + ", ".join(
            f"{g.company} {g.label}" for g in grades.values()
        )
    return GradeReport(grades=grades, best_fit=best.company, summary=summary, disclaimer=DISCLAIMER)
