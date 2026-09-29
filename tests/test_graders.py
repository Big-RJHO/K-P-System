from cardgrader.engine import grade_all
from cardgrader.graders import bgs
from cardgrader.criteria_loader import company
from cardgrader.models import CardAssessment
import pytest
from pydantic import ValidationError

from helpers import ALL, card, defect


def grades(a):
    return grade_all(a).grades


def test_flawless_card_tops_every_scale():
    g = grades(card())
    assert g["PSA"].label == "GEM MT 10"
    assert g["BGS"].label == "Pristine 10 (Black Label)"
    assert g["CGC"].label == "Pristine 10"
    assert g["TAG"].label == "Pristine 10" and g["TAG"].score >= 990


def test_micro_defect_drops_pristine_but_not_gem_mint():
    g = grades(card(defects=[defect("print_spot", "micro")]))
    assert g["PSA"].grade == 10
    assert g["BGS"].label == "Pristine 10"          # gold label, not black
    assert g["BGS"].subgrades["surface"] == 9.5
    assert g["CGC"].label == "Gem Mint 10"
    assert g["TAG"].label == "Gem Mint 10"


def test_off_center_only():
    g = grades(card(front=(70, 52)))
    assert g["PSA"].grade == 7
    assert "OC" in g["PSA"].qualifiers
    assert any(a.startswith("PSA 10 OC") for a in g["PSA"].alternatives)
    assert g["BGS"].subgrades["centering"] == 7
    assert g["TAG"].grade == 7
    assert any("65/35" in f for f in g["PSA"].limiting_factors)


def test_moderate_corner_whitening():
    g = grades(card(defects=[defect("corner_whitening", "moderate", "back", "top_left")]))
    assert g["PSA"].grade == 8
    assert g["BGS"].subgrades["corners"] == 8
    assert g["BGS"].grade == 8.5
    assert g["CGC"].grade == 8.5
    assert g["TAG"].grade == 8


def test_defects_stack():
    one = grades(card(defects=[defect("edge_whitening", "minor", "back", "top")]))
    three = grades(card(defects=[defect("edge_whitening", "minor", "back", loc) for loc in ("top", "left", "right")]))
    assert one["PSA"].grade == 9
    assert three["PSA"].grade == 8
    assert three["TAG"].score < one["TAG"].score


def test_heavy_crease_is_low_everywhere():
    g = grades(card(defects=[defect("crease", "major")]))
    assert g["PSA"].grade <= 2
    assert all(x.grade <= 3 for x in g.values())


def test_stain_sets_qualifier_alternative():
    g = grades(card(defects=[defect("stain", "moderate", "back")]))
    assert "ST" in g["PSA"].qualifiers
    assert any("ST" in a for a in g["PSA"].alternatives)


def test_altered_card_gets_no_grade():
    g = grades(card(defects=[defect("altered", "major", location="top")]))
    assert g["PSA"].label == "AUTHENTIC ALTERED"
    assert all(x.tier == 99 for x in g.values())
    assert "altered" in grade_all(card(defects=[defect("altered", "major")])).summary


def test_psa_has_no_nine_point_five():
    g = grades(card(defects=[defect("edge_silvering", "minor", location="left")]))
    assert g["PSA"].grade == 9


def test_bgs_overall_rules():
    rules, gs = company("bgs")["overall_rules"], [float(x) for x in company("bgs")["grades"]]
    ov = lambda *s: bgs.overall_grade(list(s), rules, gs)
    assert ov(10, 10, 10, 10) == 10
    assert ov(10, 10, 10, 9.5) == 10           # Pristine: three 10s and a 9.5
    assert ov(10, 10, 10, 9) == 9.5            # a 9 blocks Pristine
    assert ov(9.5, 9.5, 9.5, 9) == 9.5         # Gem Mint: three 9.5s and a 9
    assert ov(9.5, 8.5, 8.5, 9.5) == 8.5       # tied lowest subgrades
    assert ov(9.5, 9.5, 9.5, 8.5) == 9         # at most 0.5 above the lowest
    assert ov(9.5, 9.5, 9.5, 7) == 8           # outlier: lowest + 1
    assert ov(10, 10, 10, 8) == 8.5            # a sub-9 can never make 9.5


def test_tag_centering_cap():
    # 56/44 front misses TAG Gem Mint centering (55/45), so the grade can't reach 10
    g = grades(card(front=(56, 50)))
    assert g["TAG"].grade == 9
    assert g["TAG"].score <= 949


def test_best_fit_prefers_top_tier():
    report = grade_all(card(front=(56, 50)))
    assert report.best_fit in report.grades
    best = report.grades[report.best_fit]
    assert best.tier == min(g.tier for g in report.grades.values())


# ---- assessment evidence: an unassessed area is never assumed flawless ----

DEFINITIVE_TOP = ("GEM MT 10", "Pristine 10", "Pristine 10 (Black Label)", "Gem Mint 10")


def test_nothing_inspected_is_incomplete_ceiling():
    report = grade_all(card(inspected={}))
    assert report.complete is False and report.best_fit is None
    assert "not assessed yet" in report.summary and "front corners" in report.summary
    for g in report.grades.values():
        assert g.complete is False
        assert g.tier is None
        assert g.label not in DEFINITIVE_TOP
        assert g.label.startswith("Up to ") and g.label.endswith(" · incomplete")
        assert len(g.unassessed) == 6
        assert g.limiting_factors[0].startswith("Not assessed yet:")
    # The ceiling is what the card would get if every unchecked area were perfect.
    assert report.grades["PSA"].label == "Up to GEM MT 10 · incomplete"
    assert report.grades["BGS"].label == "Up to Pristine 10 (Black Label) · incomplete"
    assert report.grades["BGS"].subgrades["corners"] is None
    assert report.grades["TAG"].subgrades["back surface"] is None
    assert report.grades["TAG"].subgrades["front centering"] == 1000


def test_fully_inspected_clean_card_is_complete():
    report = grade_all(card())
    assert report.complete is True and report.unassessed == [] and report.best_fit == "PSA"
    for g in report.grades.values():
        assert g.complete is True and g.unassessed == [] and g.tier == 0
        assert "Up to" not in g.label and not any("Not assessed" in f for f in g.limiting_factors)


def test_partial_inspection_lists_missing_areas():
    a = card(
        inspected={"front": ["corners", "edges", "surface"], "back": ["edges"]},
        defects=[defect("corner_whitening", "minor", "back", "top_left")],  # a listed defect implies inspection
    )
    report = grade_all(a)
    assert report.unassessed == ["back surface"]
    for g in report.grades.values():
        assert g.complete is False and g.unassessed == ["back surface"]
    # The corner defect still caps the ceiling.
    assert report.grades["PSA"].grade == 9 and report.grades["PSA"].label == "Up to MINT 9 · incomplete"
    assert report.grades["BGS"].subgrades["corners"] == 9 and report.grades["BGS"].subgrades["surface"] is None


def test_defects_found_still_cap_an_incomplete_ceiling():
    g = grades(card(inspected={}, defects=[defect("corner_whitening", "moderate", "back", "top_left")]))
    assert g["PSA"].grade == 8 and g["PSA"].complete is False
    assert "front corners" in g["PSA"].unassessed and "back corners" not in g["PSA"].unassessed
    assert g["PSA"].subgrades["corners"] == 8  # the pooled corners grade is a ceiling from what was found
    assert g["TAG"].subgrades["back corners"] == 820 and g["TAG"].subgrades["front corners"] is None


def test_unread_centering_counts_as_55_and_is_unassessed():
    report = grade_all(card(evidence={"front": {"lr": "unread", "tb": "unread"}}))
    assert report.complete is False
    assert report.unassessed == ["front centering (left/right)", "front centering (top/bottom)"]
    psa = report.grades["PSA"]
    assert psa.label == "Up to GEM MT 10 · incomplete"          # 55/45 still makes PSA 10 centering
    assert report.grades["BGS"].subgrades["centering"] == 9.5   # but not BGS Pristine centering
    assert report.grades["TAG"].subgrades["front centering"] == 950
    assert psa.notes[0].startswith("Centering wasn't measured (front left/right, front top/bottom)")
    # The back defaults to typed because centering was given.
    assert CardAssessment().centering_evidence["back"] == {"lr": "unread", "tb": "unread"}
    assert card().centering_evidence["back"] == {"lr": "typed", "tb": "typed"}


def test_altered_card_is_complete_even_if_not_inspected():
    report = grade_all(card(inspected={}, defects=[defect("altered", "major")]))
    assert report.complete is True and all(g.tier == 99 for g in report.grades.values())


# ---- photo limits: the photo check wins over a claim that an area was inspected ----

# What the scan reported for the slab photos of the PSA blind test: no edge or corner can be judged.
SLAB_BLOCKED = [f"edges:{e}" for e in ("top", "right", "bottom", "left")] + [
    f"corners:{c}" for c in ("top_left", "top_right", "bottom_right", "bottom_left")
]


def test_photo_limits_accept_scan_blocked_items():
    a = card(photo_limits={"front": SLAB_BLOCKED + ["centering"], "back": ["surface", "edges"]})
    assert a.photo_limits == {"front": ["corners", "edges"], "back": ["edges", "surface"]}
    with pytest.raises(ValidationError):
        card(photo_limits={"front": ["edges:middle"]})
    with pytest.raises(ValidationError):
        card(photo_limits={"front": ["gloss"]})


def test_photo_limited_areas_claimed_as_inspected_stay_incomplete():
    # Every area ticked as inspected, no defects, but the photos can't show corners or edges.
    report = grade_all(card(photo_limits={"front": SLAB_BLOCKED, "back": SLAB_BLOCKED}))
    assert report.complete is False and report.best_fit is None
    assert report.unassessed == [
        "front corners (photo can't show them)",
        "front edges (photo can't show them)",
        "back corners (photo can't show them)",
        "back edges (photo can't show them)",
    ]
    psa = report.grades["PSA"]
    assert psa.complete is False and psa.tier is None
    assert psa.label == "Up to GEM MT 10 · incomplete"
    assert psa.subgrades["corners"] is None and psa.subgrades["surface"] == 10
    assert report.grades["TAG"].subgrades["front edges"] is None
    assert report.grades["TAG"].subgrades["front surface"] == 1000


def test_defects_in_photo_limited_area_lower_the_ceiling_but_stay_unassessed():
    a = card(
        defects=[defect("corner_whitening", "moderate", "back", "top_left")],
        photo_limits={"back": ["corners:top_left"]},
    )
    report = grade_all(a)
    assert report.complete is False
    assert report.unassessed == ["back corners (photo can't show them)"]
    psa = report.grades["PSA"]
    assert psa.grade == 8 and psa.label == "Up to NM-MT 8 · incomplete"
    assert report.grades["TAG"].subgrades["back corners"] == 820  # a ceiling from what was found
    # The same defect on a photo that shows the corners gives a complete grade.
    assert grade_all(card(defects=[defect("corner_whitening", "moderate", "back", "top_left")])).complete is True


def test_inspected_in_hand_overrides_photo_limits():
    limits = {"front": SLAB_BLOCKED, "back": SLAB_BLOCKED}
    report = grade_all(card(photo_limits=limits, in_hand=ALL))
    assert report.complete is True and report.best_fit == "PSA"
    assert report.grades["PSA"].label == "GEM MT 10"
    # Only the areas checked in hand are lifted.
    partial = grade_all(card(photo_limits=limits, in_hand={"front": ["corners", "edges"], "back": ["corners"]}))
    assert partial.unassessed == ["back edges (photo can't show them)"]
    # Checked in hand counts even when nothing is listed in `inspected`.
    assert grade_all(card(inspected={}, in_hand=ALL)).complete is True


def test_defect_location_must_match_its_type():
    with pytest.raises(ValidationError, match="print_spot"):
        card(defects=[defect("print_spot", "minor", "front", "top")])
    with pytest.raises(ValidationError):
        card(defects=[defect("corner_whitening", "minor", "front", "left")])
    with pytest.raises(ValidationError):
        card(defects=[defect("edge_whitening", "minor", "front", "surface")])
    # Types with several areas accept each of them.
    card(defects=[defect("crease", "minor", "front", "top_left"), defect("crease", "minor", "front", "surface")])
    card(defects=[defect("hole", "minor", "back", "left"), defect("hole", "minor", "back", "bottom_right")])
