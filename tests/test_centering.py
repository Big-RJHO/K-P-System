import pytest

from cardgrader import criteria_loader
from cardgrader.centering import centering_grade, interpolate
from cardgrader.models import Borders, SideCentering
from helpers import card


def test_ratio_from_borders():
    c = SideCentering.from_borders(Borders(left=12, right=8, top=10, bottom=10))
    assert c.lr == 60 and c.tb == 50 and c.worst == 60


@pytest.mark.parametrize(
    "front,back,expected",
    [
        ((55, 50), (75, 50), 10),   # exactly at the PSA 10 limits
        ((56, 50), (50, 50), 9),    # front just past 55/45
        ((50, 50), (80, 50), 9),    # back past 75/25
        ((70, 60), (50, 50), 7),
        ((95, 50), (50, 50), 1),
    ],
)
def test_psa_centering(front, back, expected):
    assert centering_grade(card(front, back).centering, criteria_loader.company("psa")).grade == expected


def test_bgs_one_way_other_way():
    crit = criteria_loader.company("bgs")
    # BGS 10 needs 50/50 one way and 55/45 the other
    assert centering_grade(card((55, 50)).centering, crit).grade == 10
    assert centering_grade(card((55, 53)).centering, crit).grade == 9.5
    assert centering_grade(card((58, 54)).centering, crit).grade == 9
    assert centering_grade(card((58, 56)).centering, crit).grade == 8.5  # misses 55/45 one way


def test_limiting_reason_names_the_next_grade():
    res = centering_grade(card((62, 50)).centering, criteria_loader.company("psa"))
    assert res.grade == 8
    assert any("needed for 9" in r for r in res.limiting)


def test_interpolate():
    pts = [[50, 1000], [55, 950], [60, 900]]
    assert interpolate(pts, 50) == 1000
    assert interpolate(pts, 52.5) == 975
    assert interpolate(pts, 70) == 900
