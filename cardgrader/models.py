"""Data model shared by the vision pipeline, the graders and the web API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

Side = Literal["front", "back"]
Component = Literal["corners", "edges", "surface"]
Severity = Literal["micro", "minor", "moderate", "major"]

CORNER_LOCATIONS = ("top_left", "top_right", "bottom_left", "bottom_right")
EDGE_LOCATIONS = ("top", "right", "bottom", "left")
SURFACE_LOCATIONS = ("surface",)


def location_component(location: str) -> Component:
    if location in CORNER_LOCATIONS:
        return "corners"
    if location in EDGE_LOCATIONS:
        return "edges"
    if location in SURFACE_LOCATIONS:
        return "surface"
    raise ValueError(f"unknown location {location!r}")


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
        location_component(self.location)
        return self


class CardInfo(BaseModel):
    name: str = ""
    set_name: str = ""
    number: str = ""
    holo: bool = False
    notes: str = ""


class CardAssessment(BaseModel):
    card: CardInfo = Field(default_factory=CardInfo)
    centering: Centering = Field(default_factory=Centering)
    defects: list[Defect] = Field(default_factory=list)


class CompanyGrade(BaseModel):
    company: Literal["PSA", "BGS", "CGC", "TAG"]
    grade: float = Field(description="Numeric grade on the company's scale (10 for any 10 label)")
    label: str = Field(description="Label text, e.g. 'Gem Mint 10' or 'Pristine 10 (Black Label)'")
    tier: int = Field(description="0 = company's very top label, 1 = next label down, ...")
    subgrades: dict[str, float | str] = Field(default_factory=dict)
    score: int | None = Field(default=None, description="TAG score (100-1000)")
    qualifiers: list[str] = Field(default_factory=list)
    alternatives: list[str] = Field(default_factory=list)
    limiting_factors: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class GradeReport(BaseModel):
    grades: dict[str, CompanyGrade]
    best_fit: str
    summary: str
    disclaimer: str
