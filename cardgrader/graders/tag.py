"""TAG: eight area sub-scores combined into a 100-1000 TAG Score, then mapped to a grade."""

from __future__ import annotations

from .. import criteria_loader
from ..centering import centering_grade, interpolate
from ..condition import COMPONENTS, SIDES, component_conditions, floor_to
from ..models import CardAssessment, CompanyGrade
from .base import altered_grade


def condition_points(condition: float, table: dict) -> float:
    keys = sorted(float(k) for k in table)
    key = floor_to(keys, condition)
    return float({float(k): v for k, v in table.items()}[key])


def band_for(score: float, bands: list) -> tuple[int, float, str]:
    for i, (minimum, grade_value, label) in enumerate(bands):
        if score >= minimum:
            return i, float(grade_value), label
    minimum, grade_value, label = bands[-1]
    return len(bands) - 1, float(grade_value), label


def grade(assessment: CardAssessment) -> CompanyGrade:
    if altered := altered_grade("TAG", assessment):
        return altered
    crit = criteria_loader.company("tag")
    bands = crit["bands"]

    areas: dict[str, float] = {}
    for side in SIDES:
        split = getattr(assessment.centering, side).worst
        areas[f"{side} centering"] = interpolate(crit["centering_points"][side], split)
    cond = component_conditions(assessment, "TAG", per_side=True)
    for (side, comp), cc in cond.items():
        areas[f"{side} {comp}"] = condition_points(cc.grade, crit["condition_points"])

    weights = {
        f"{side} {comp}": crit["side_weights"][side] / 4
        for side in SIDES
        for comp in ("centering", *COMPONENTS)
    }
    mean = sum(areas[k] * w for k, w in weights.items())
    lowest = min(areas.values())
    w = crit["weakest_weight"]
    score = w * lowest + (1 - w) * mean

    # TAG's published centering tolerances are hard limits on the grade.
    cent = centering_grade(assessment.centering, crit)
    cap_index = next(i for i, b in enumerate(bands) if float(b[1]) <= cent.grade)
    if cap_index > 0:
        score = min(score, bands[cap_index - 1][0] - 1)
    score = int(round(max(100.0, min(1000.0, score))))

    tier, grade_value, label = band_for(score, bands)

    limiting = []
    if tier > 0:
        for name, pts in sorted(areas.items(), key=lambda kv: kv[1])[:3]:
            if pts >= 990:
                break
            reason = ""
            side, comp = name.split(" ")
            if comp == "centering":
                reason = getattr(assessment.centering, side).label()
            elif cond[(side, comp)].reasons:
                reason = "; ".join(cond[(side, comp)].reasons)
            limiting.append(f"{name.capitalize()} {pts:.0f} pts" + (f": {reason}" if reason else ""))
        if cap_index > 0 and cent.limiting:
            limiting.append("Centering tolerance: " + "; ".join(cent.limiting))

    return CompanyGrade(
        company="TAG",
        grade=min(grade_value, 10.0),
        label=label,
        tier=tier,
        score=score,
        subgrades={k: round(v) for k, v in areas.items()},
        limiting_factors=limiting,
        notes=["TAG's real score comes from its own imaging. This estimate combines the eight area scores."],
    )
