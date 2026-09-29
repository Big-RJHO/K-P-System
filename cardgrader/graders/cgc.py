"""CGC Cards: weakest-link overall grade with a small bump, Pristine vs Gem Mint 10 at the top."""

from __future__ import annotations

from .. import criteria_loader
from ..centering import centering_grade
from ..condition import component_conditions, floor_to
from ..models import CardAssessment, CompanyGrade
from .base import altered_grade, binding_factors, finish, prepare, shown_subgrades


def overall_grade(subs: list[float], rules: dict, grades: list[float]) -> float:
    ordered = sorted(subs)
    lowest, second = ordered[0], ordered[1]
    if lowest >= 9.5 or ordered.count(lowest) >= 2:
        # No bump near the top: Gem Mint 10 needs every area at Gem Mint, and Pristine needs every area Pristine.
        overall = lowest
    else:
        overall = min(lowest + rules["max_above_lowest"], second, 9.5)
    return floor_to(grades, overall)


def grade(assessment: CardAssessment) -> CompanyGrade:
    if altered := altered_grade("CGC", assessment):
        return altered
    assessment = prepare(assessment)
    crit = criteria_loader.company("cgc")
    grades = [float(g) for g in crit["grades"]]

    cent = centering_grade(assessment.centering, crit)
    cond = component_conditions(assessment, "CGC")
    # An unassessed component counts at its best case, so the overall grade is a ceiling.
    subs = {"centering": cent.grade, **{c: floor_to(grades, cc.ceiling) for c, cc in cond.items()}}
    overall = overall_grade(list(subs.values()), crit["overall_rules"], grades)

    limiting = [] if overall == 10.5 else binding_factors(min(subs.values()), subs, cent.limiting, cond)

    return finish(CompanyGrade(
        company="CGC",
        grade=min(overall, 10.0),
        label=crit["labels"][overall],
        tier=grades.index(overall),
        subgrades=shown_subgrades(subs, cond),
        limiting_factors=limiting,
        notes=["CGC subgrades are optional, and a 10.5 subgrade here means Pristine."],
    ), assessment)
