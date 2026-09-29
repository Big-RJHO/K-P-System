"""Run every company grader over one assessment.

If an area wasn't assessed (see ``models``), every company grade is an incomplete ceiling, the report has
``complete=False`` and ``best_fit=None``, and the summary names what is missing instead of a best fit.
"""

from __future__ import annotations

from .condition import unassessed_areas
from .graders import GRADERS
from .models import CardAssessment, GradeReport

DISCLAIMER = (
    "Theoretical estimate built from each company's published grading standards. "
    "Not affiliated with or endorsed by PSA, Beckett, CGC or TAG. Real grades depend on "
    "each company's inspection and can differ."
)


def grade_all(assessment: CardAssessment) -> GradeReport:
    grades = {name: fn(assessment) for name, fn in GRADERS.items()}
    complete = all(g.complete for g in grades.values())
    best_fit: str | None = None
    if not complete:
        # An incomplete grade is only a ceiling, so no company is named as the best fit.
        summary = f"Incomplete: not assessed yet: {', '.join(unassessed_areas(assessment))}. Best case: " + ", ".join(
            f"{g.company} {g.label}" for g in grades.values()
        )
    else:
        # Best fit: the company where the card lands closest to that company's top label.
        # Ties go to dict order (PSA, BGS, CGC, TAG). An altered card is complete: nothing can change it.
        best = min(grades.values(), key=lambda g: g.tier)
        best_fit = best.company
        if best.tier >= 99:
            summary = "The card appears altered, so no company will give it a numeric grade."
        else:
            summary = f"Best fit: {best.company} {best.label}. " + ", ".join(
                f"{g.company} {g.label}" for g in grades.values()
            )
    return GradeReport(
        grades=grades,
        complete=complete,
        unassessed=[] if complete else unassessed_areas(assessment),
        best_fit=best_fit,
        summary=summary,
        disclaimer=DISCLAIMER,
    )
