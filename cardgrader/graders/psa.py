"""PSA: one holistic grade, driven by the weakest attribute, plus qualifiers."""

from __future__ import annotations

from .. import criteria_loader
from ..centering import centering_grade
from ..condition import component_conditions, floor_to, qualifier_flags
from ..models import CardAssessment, CompanyGrade
from .base import altered_grade, binding_factors, finish, prepare, shown_subgrades


def _body_grade(assessment: CardAssessment, grades: list[float]) -> tuple[float, dict]:
    cond = component_conditions(assessment, "PSA")
    # An unassessed component counts at its best case, so the overall grade is a ceiling.
    parts = {c: floor_to(grades, min(10.0, cc.ceiling)) for c, cc in cond.items()}
    return min(parts.values()), {"parts": parts, "cond": cond}


def grade(assessment: CardAssessment) -> CompanyGrade:
    if altered := altered_grade("PSA", assessment):
        return altered
    assessment = prepare(assessment)
    crit = criteria_loader.company("psa")
    grades = [float(g) for g in crit["grades"]]

    cent = centering_grade(assessment.centering, crit)
    body, info = _body_grade(assessment, grades)
    parts = {"centering": cent.grade, **info["parts"]}
    overall = floor_to(grades, min(body, cent.grade))

    qualifiers = qualifier_flags(assessment)
    alternatives: list[str] = []
    if cent.grade < body:
        qualifiers = ["OC", *qualifiers]
        alternatives.append(
            f"PSA {body:g} OC: PSA may grade the rest of the card and add the off-center qualifier"
        )
    for q in qualifier_flags(assessment):
        remaining = [
            d
            for d in assessment.defects
            if not (
                criteria_loader.defect_type(d.type).get("qualifier") == q
                and d.severity in ("moderate", "major")
            )
        ]
        alt_body, _ = _body_grade(assessment.model_copy(update={"defects": remaining}), grades)
        alt = floor_to(grades, min(alt_body, cent.grade))
        if alt > overall:
            alternatives.append(f"PSA {alt:g} {q}: graded with the {q} qualifier instead of for the flaw")

    notes = []
    if overall == 10 and any(v < 10 for v in parts.values()):
        notes.append("PSA 10 still allows slight printing imperfections visible under magnification.")

    return finish(CompanyGrade(
        company="PSA",
        grade=overall,
        label=crit["labels"][overall],
        tier=grades.index(overall),
        subgrades=shown_subgrades(parts, info["cond"]),
        qualifiers=qualifiers,
        alternatives=alternatives,
        limiting_factors=[] if overall == 10 else binding_factors(overall, parts, cent.limiting, info["cond"]),
        notes=notes + ["PSA doesn't print subgrades. The component values shown are estimates."],
    ), assessment)
