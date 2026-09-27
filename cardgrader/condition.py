"""Turn a list of defects into a condition grade for each component.

The condition scale is shared by all graders: 10.5 = flawless (Pristine),
10 = Gem Mint, 9 = Mint, ... 1 = Poor. Each company converts it to its own scale.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import criteria_loader
from .models import CardAssessment, Component, Defect, Side

FLAWLESS = 10.5
COMPONENTS: tuple[Component, ...] = ("corners", "edges", "surface")
SIDES: tuple[Side, ...] = ("front", "back")


@dataclass
class ComponentCondition:
    grade: float = FLAWLESS
    reasons: list[str] = field(default_factory=list)


def defect_cap(defect: Defect, company: str | None = None) -> float:
    spec = criteria_loader.defect_type(defect.type)
    if company:
        override = spec.get("overrides", {}).get(company.upper(), {})
        if defect.severity in override:
            return float(override[defect.severity])
    return float(spec["caps"][defect.severity])


def describe(defect: Defect) -> str:
    spec = criteria_loader.defect_type(defect.type)
    where = defect.location.replace("_", " ")
    if defect.location == "surface":
        where = f"{defect.side} surface"
    else:
        where = f"{defect.side} {where} {'corner' if defect.component == 'corners' else 'edge'}"
    return f"{defect.severity} {spec['label'].lower()} ({where})"


def _condition(defects: list[Defect], company: str | None) -> ComponentCondition:
    if not defects:
        return ComponentCondition()
    rules = criteria_loader.defects()["component_rules"]
    capped = sorted(((defect_cap(d, company), d) for d in defects), key=lambda cd: cd[0])
    worst_cap, worst = capped[0]
    grade = worst_cap
    reasons = [f"{describe(worst)} caps it at {worst_cap:g}"]

    others = [c for c, _ in capped[1:] if c < 10]
    if others:
        penalty = min(rules["stack_penalty"] * len(others), rules["max_stack_penalty"])
        grade -= penalty
        reasons.append(f"{len(others)} more defect(s) take off another {penalty:g}")

    micro = [d for d in defects if d.severity == "micro"]
    if len(micro) >= rules["micro_stack_count"] and grade > 9.5:
        grade = 9.5
        reasons.append(f"{len(micro)} micro defects add up")

    return ComponentCondition(grade=max(1.0, grade), reasons=reasons)


def component_conditions(
    assessment: CardAssessment, company: str | None = None, per_side: bool = False
) -> dict:
    """Condition of each component.

    With ``per_side=False`` this returns ``{component: ComponentCondition}`` using defects from both sides.
    With ``per_side=True`` it returns ``{(side, component): ComponentCondition}``.
    """
    if per_side:
        return {
            (side, comp): _condition(
                [d for d in assessment.defects if d.side == side and d.component == comp], company
            )
            for side in SIDES
            for comp in COMPONENTS
        }
    return {
        comp: _condition([d for d in assessment.defects if d.component == comp], company)
        for comp in COMPONENTS
    }


def fatal_defects(assessment: CardAssessment) -> list[Defect]:
    return [d for d in assessment.defects if criteria_loader.defect_type(d.type).get("fatal")]


def qualifier_flags(assessment: CardAssessment) -> list[str]:
    """PSA-style qualifiers triggered by moderate or major defects."""
    flags: list[str] = []
    for d in assessment.defects:
        q = criteria_loader.defect_type(d.type).get("qualifier")
        if q and d.severity in ("moderate", "major") and q not in flags:
            flags.append(q)
    return flags


def floor_to(grades: list[float], value: float) -> float:
    """Largest allowed grade that is <= value (grades may be in any order)."""
    eligible = [g for g in grades if g <= value + 1e-9]
    return max(eligible) if eligible else min(grades)
