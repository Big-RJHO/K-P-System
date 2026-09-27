from cardgrader.engine import grade_all
from cardgrader.graders import bgs
from cardgrader.criteria_loader import company
from helpers import card, defect


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
