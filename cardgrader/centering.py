"""Look up a company's centering grade from measured front/back splits."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import CardAssessment, Centering, SideCentering

# This project's convention, not a company rule: a centering axis nobody measured (no photo, or the photo
# didn't show that border) counts as just making Gem Mint (55/45), so it can't lift a card to Pristine.
UNREAD_SHARE = 55.0


def axis_name(axis: str) -> str:
    return "left/right" if axis == "lr" else "top/bottom"


def graded_centering(assessment: CardAssessment) -> Centering:
    """Centering used for grading: each unread axis counts as at least UNREAD_SHARE."""
    sides = {}
    for side in ("front", "back"):
        sc = getattr(assessment.centering, side)
        evidence = assessment.centering_evidence.get(side, {})
        sides[side] = SideCentering(
            **{
                axis: max(getattr(sc, axis), UNREAD_SHARE) if evidence.get(axis) == "unread" else getattr(sc, axis)
                for axis in ("lr", "tb")
            }
        )
    return Centering(**sides)


def _fmt(share: float) -> str:
    share = round(share, 1)
    other = round(100 - share, 1)
    if share == int(share):
        return f"{int(share)}/{int(other)}"
    return f"{share}/{other}"


@dataclass
class CenteringResult:
    grade: float
    limiting: list[str]  # why the card misses the next row up


def _side_fails(side: SideCentering, row: dict[str, Any], key: str, tol: float) -> list[str]:
    reasons = []
    limit = row[key]
    if side.worst > limit + tol:
        reasons.append(f"{key} centering {_fmt(side.worst)} exceeds {_fmt(limit)}")
    other_key = f"{key}_other"
    if other_key in row and side.best > row[other_key] + tol:
        reasons.append(
            f"{key} centering needs {_fmt(row[other_key])} on one axis (best axis is {_fmt(side.best)})"
        )
    return reasons


def centering_grade(centering: Centering, criteria: dict[str, Any]) -> CenteringResult:
    """Return the highest row in ``criteria['centering']`` that both sides pass."""
    tol = float(criteria.get("tolerance", 0.0))
    rows = criteria["centering"]
    previous_fail: list[str] = []
    for row in rows:
        fails = _side_fails(centering.front, row, "front", tol) + _side_fails(
            centering.back, row, "back", tol
        )
        if not fails:
            return CenteringResult(grade=float(row["grade"]), limiting=previous_fail)
        previous_fail = [f"{r} (needed for {row['grade']:g})" for r in fails]
    return CenteringResult(grade=float(rows[-1]["grade"]), limiting=previous_fail)


def interpolate(points: list[list[float]], x: float) -> float:
    """Piecewise-linear interpolation over sorted [x, y] points, clamped at both ends."""
    if x <= points[0][0]:
        return float(points[0][1])
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0) if x1 != x0 else 0.0
            return float(y0 + t * (y1 - y0))
    return float(points[-1][1])
