"""Data model shared by the vision pipeline, the graders and the web API.

Assessment evidence (this project's convention, not a grading company's rule):

- ``CardAssessment.inspected[side]`` lists the components (corners, edges, surface) that were looked at
  under good light, with everything found listed in ``defects``. A component with a defect listed on a
  side counts as inspected on that side too. Anything else is *unassessed*: it is never assumed flawless.
- ``CardAssessment.centering_evidence[side][axis]`` says where each centering share came from:
  ``"measured"`` (read from the photo or lined up by hand), ``"typed"`` (entered as a number) or
  ``"unread"`` (the photo didn't show that border, or there was no photo). An unread axis is graded as
  at least 55/45 (``centering.UNREAD_SHARE``) and is listed as unassessed. When the evidence for an axis
  is missing it defaults to ``"typed"`` if ``centering`` was given, and ``"unread"`` if it wasn't.

When anything is unassessed, each ``CompanyGrade`` has ``complete=False``, lists what is missing in
``unassessed`` (e.g. ``["front corners", "back centering (left/right)"]``) and its ``grade``/``score`` are a
*ceiling*: the grade the card would get if every unassessed area turned out perfect (unread centering
still counts as 55/45). Its ``label`` reads "Up to <label> · incomplete" and its ``tier`` is ``None``.
``GradeReport.complete`` is False when any company grade is, and ``best_fit`` is then ``None``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from . import criteria_loader

Side = Literal["front", "back"]
Component = Literal["corners", "edges", "surface"]
Severity = Literal["micro", "minor", "moderate", "major"]
Axis = Literal["lr", "tb"]
Evidence = Literal["measured", "typed", "unread"]

CORNER_LOCATIONS = ("top_left", "top_right", "bottom_left", "bottom_right")
EDGE_LOCATIONS = ("top", "right", "bottom", "left")
SURFACE_LOCATIONS = ("surface",)


COMPONENTS: tuple[Component, ...] = ("corners", "edges", "surface")


def location_component(location: str) -> Component:
    if location in CORNER_LOCATIONS:
        return "corners"
    if location in EDGE_LOCATIONS:
        return "edges"
    if location in SURFACE_LOCATIONS:
        return "surface"
    raise ValueError(f"unknown location {location!r}")


def photo_limit_components(items) -> list[Component]:
    """Components a photo can't show, from the scan's ``quality.blocked`` items or plain component names.

    ``"edges:top"`` -> ``edges``, ``"corners:top_left"`` -> ``corners``, ``"surface"``/``"edges"``/``"corners"``
    as they are; ``"centering"`` is dropped (centering has its own evidence). Returned in component order.
    """
    found: set[str] = set()
    for item in items or []:
        if not isinstance(item, str):
            raise ValueError(f"photo limit must be a string, got {item!r}")
        comp, _, where = item.partition(":")
        if comp == "centering" and not where:
            continue
        allowed = {"corners": CORNER_LOCATIONS, "edges": EDGE_LOCATIONS, "surface": ()}.get(comp)
        if allowed is None or (where and where not in allowed):
            raise ValueError(f"unknown photo limit {item!r}")
        found.add(comp)
    return [c for c in COMPONENTS if c in found]


def split_ratio(a: float, b: float) -> float:
    """Return the larger share of a/b as a percentage (e.g. 12px vs 8px -> 60.0 for 60/40)."""
    total = a + b
    if total <= 0:
        return 50.0
    return max(a, b) / total * 100.0


class Borders(BaseModel):
    """Border widths (pixels or any consistent unit) between card edge and inner frame."""

    left: float = Field(ge=0)
    right: float = Field(ge=0)
    top: float = Field(ge=0)
    bottom: float = Field(ge=0)

    @property
    def lr(self) -> float:
        return split_ratio(self.left, self.right)

    @property
    def tb(self) -> float:
        return split_ratio(self.top, self.bottom)


class SideCentering(BaseModel):
    """Centering of one side, expressed as the larger share of each axis (50 = perfect)."""

    lr: float = Field(ge=50, le=100, description="Left/right split, larger share, e.g. 55 for 55/45")
    tb: float = Field(ge=50, le=100, description="Top/bottom split, larger share")

    @classmethod
    def from_borders(cls, borders: Borders) -> "SideCentering":
        return cls(lr=round(borders.lr, 2), tb=round(borders.tb, 2))

    @property
    def worst(self) -> float:
        return max(self.lr, self.tb)

    @property
    def best(self) -> float:
        return min(self.lr, self.tb)

    def label(self) -> str:
        def fmt(v: float) -> str:
            return f"{v:.0f}/{100 - v:.0f}" if abs(v - round(v)) < 0.05 else f"{v:.1f}/{100 - v:.1f}"

        return f"L/R {fmt(self.lr)}, T/B {fmt(self.tb)}"


class Centering(BaseModel):
    front: SideCentering = Field(default_factory=lambda: SideCentering(lr=50, tb=50))
    back: SideCentering = Field(default_factory=lambda: SideCentering(lr=50, tb=50))


class Defect(BaseModel):
    side: Side
    location: str = Field(description="Corner (top_left...), edge (top/right/bottom/left) or 'surface'")
    type: str = Field(description="Key from criteria/defects.yaml")
    severity: Severity
    note: str | None = None

    @property
    def component(self) -> Component:
        return location_component(self.location)

    @model_validator(mode="after")
    def _check_location(self) -> "Defect":
        component = location_component(self.location)
        # Each defect type only occurs in the areas defects.yaml allows (e.g. a print spot is on the surface,
        # not at an edge). An unknown type is reported by the graders (KeyError), as before.
        spec = criteria_loader.defects()["types"].get(self.type)
        if spec is not None and component not in spec["applies_to"]:
            raise ValueError(
                f"{self.type!r} can't be at {self.location!r} ({component}); it applies to: "
                f"{', '.join(spec['applies_to'])} (locations: {', '.join(allowed_locations(spec['applies_to']))})"
            )
        return self


def allowed_locations(components) -> list[str]:
    by_comp = {"corners": CORNER_LOCATIONS, "edges": EDGE_LOCATIONS, "surface": SURFACE_LOCATIONS}
    return [loc for comp in COMPONENTS if comp in components for loc in by_comp[comp]]


class CardInfo(BaseModel):
    game: str = Field(default="pokemon", description="Card game, e.g. 'pokemon' or 'riftbound'")
    name: str = ""
    subtitle: str = ""
    set_name: str = ""
    set_code: str = ""
    number: str = ""
    rarity: str = ""
    card_type: str = ""
    finish: str = ""
    language: str = ""
    year: str = ""
    holo: bool = False
    notes: str = ""


class CardAssessment(BaseModel):
    card: CardInfo = Field(default_factory=CardInfo)
    centering: Centering = Field(default_factory=Centering)
    defects: list[Defect] = Field(default_factory=list)
    inspected: dict[Side, list[Component]] = Field(
        default_factory=dict,
        description="Components inspected on each side; any defects found there are listed in `defects`",
    )
    centering_evidence: dict[Side, dict[Axis, Evidence]] = Field(
        default_factory=dict,
        description="Where each centering share came from: measured, typed or unread",
    )
    photo_limits: dict[Side, list[Component]] = Field(
        default_factory=dict,
        description="Components the photo of each side can't show (from the scan's quality.blocked). "
        "They stay unassessed even if listed in `inspected`",
    )
    inspected_in_hand: dict[Side, list[Component]] = Field(
        default_factory=dict,
        description="Components a person examined on the physical card under good light, not on the photo. "
        "They count as inspected whatever the photo showed",
    )

    @field_validator("photo_limits", mode="before")
    @classmethod
    def _limits_from_blocked(cls, value):
        if value is None:
            return {}
        if isinstance(value, dict):
            return {side: photo_limit_components(items) for side, items in value.items()}
        return value

    @model_validator(mode="before")
    @classmethod
    def _fill_evidence(cls, data):
        # Missing evidence: numbers the caller gave count as typed; the default 50/50 counts as unread.
        if isinstance(data, dict):
            default = "typed" if data.get("centering") is not None else "unread"
            given = data.get("centering_evidence") or {}
            data = {
                **data,
                "centering_evidence": {
                    side: {axis: (given.get(side) or {}).get(axis, default) for axis in ("lr", "tb")}
                    for side in ("front", "back")
                },
            }
        return data

    def is_inspected(self, side: Side, component: Component) -> bool:
        """Was this component said to be looked at on this side? A listed defect counts as having looked."""
        return component in self.inspected.get(side, []) or any(
            d.side == side and d.component == component for d in self.defects
        )

    def is_photo_limited(self, side: Side, component: Component) -> bool:
        """Can't the photo show this component, with nobody having checked it on the card in hand?"""
        return component in self.photo_limits.get(side, []) and component not in self.inspected_in_hand.get(side, [])

    def is_assessed(self, side: Side, component: Component) -> bool:
        """Is there evidence for this component? Checked in hand, or inspected where the photo can show it."""
        if component in self.inspected_in_hand.get(side, []):
            return True
        return not self.is_photo_limited(side, component) and self.is_inspected(side, component)


class CompanyGrade(BaseModel):
    company: Literal["PSA", "BGS", "CGC", "TAG"]
    grade: float = Field(
        description="Numeric grade on the company's scale (10 for any 10 label). A ceiling when not complete."
    )
    label: str = Field(description="Label text, e.g. 'Gem Mint 10' or 'Up to Gem Mint 10 · incomplete'")
    tier: int | None = Field(
        description="0 = company's very top label, 1 = next label down, ...; None when not complete"
    )
    complete: bool = Field(default=True, description="False when an area wasn't assessed: grade is a ceiling")
    unassessed: list[str] = Field(default_factory=list, description="Areas not assessed, e.g. 'front corners'")
    subgrades: dict[str, float | str | None] = Field(
        default_factory=dict, description="None for an area that wasn't assessed"
    )
    score: int | None = Field(default=None, description="TAG score (100-1000); a ceiling when not complete")
    qualifiers: list[str] = Field(default_factory=list)
    alternatives: list[str] = Field(default_factory=list)
    limiting_factors: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class GradeReport(BaseModel):
    grades: dict[str, CompanyGrade]
    complete: bool = True
    unassessed: list[str] = Field(default_factory=list)
    best_fit: str | None = Field(description="None when the report is incomplete")
    summary: str
    disclaimer: str
