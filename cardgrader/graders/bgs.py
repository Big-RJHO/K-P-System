"""Beckett: four subgrades combined by the BGS overall-grade rules."""

from __future__ import annotations

from .. import criteria_loader
from ..centering import centering_grade
from ..condition import FLAWLESS, component_conditions, floor_to
from ..models import CardAssessment, CompanyGrade
from .base import altered_grade, binding_factors


def to_subgrade(condition: float, grades: list[float]) -> float:
    """Convert a shared condition grade to a BGS subgrade.

    On the BGS scale a 10 subgrade means Pristine, so shared-scale Gem Mint (10) becomes 9.5.
    """
    if condition >= FLAWLESS:
        return 10.0
    return floor_to(grades, min(condition, 9.5))


def overall_grade(subs: list[float], rules: dict, grades: list[float]) -> float:
    ordered = sorted(subs)
    lowest, second = ordered[0], ordered[1]
    if ordered.count(lowest) >= 2:
        overall = lowest
    elif second - lowest >= rules["outlier_gap"]:
        overall = min(lowest + rules["outlier_bonus"], second)
    else:
        overall = min(lowest + rules["max_above_lowest"], second)
    # Gem Mint 9.5 needs three 9.5s and the fourth no lower than 9.
    if overall >= 9.5 and lowest < 9:
        overall = 9.0
    # Pristine 10 needs three 10s and the fourth at 9.5 or higher.
    if overall >= 10 and (sum(1 for s in subs if s >= 10) < 3 or lowest < 9.5):
        overall = 9.5
    return floor_to(grades, overall)


def grade(assessment: CardAssessment) -> CompanyGrade:
    if altered := altered_grade("BGS", assessment):
        return altered
    crit = criteria_loader.company("bgs")
    grades = [float(g) for g in crit["grades"]]

    cent = centering_grade(assessment.centering, crit)
    cond = component_conditions(assessment, "BGS")
    subs = {"centering": cent.grade, **{c: to_subgrade(cc.grade, grades) for c, cc in cond.items()}}
    overall = overall_grade(list(subs.values()), crit["overall_rules"], grades)

    black = all(v == 10 for v in subs.values())
    label = crit["black_label"] if black else crit["labels"][overall]
    tier = 0 if black else grades.index(overall) + 1

    limiting: list[str] = []
    if not black:
        limiting = binding_factors(min(subs.values()), subs, cent.limiting, cond)
        if overall == 10:
            limiting.insert(0, "A Black Label needs all four subgrades at 10")

    return CompanyGrade(
        company="BGS",
        grade=overall,
        label=label,
        tier=tier,
        subgrades=subs,
        limiting_factors=limiting,
        notes=["Beckett's real overall-grade formula is proprietary. This model follows its published rules."],
    )
