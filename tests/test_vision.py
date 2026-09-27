import pytest

from cardgrader.models import SideCentering
from cardgrader.vision import find_card, measure_borders, warp_card
from synthetic import make_card, place_on_background

MARGIN = 24
CASES = [
    ((40, 30, 45, 45), 3, (40, 205, 245)),     # yellow border, L/R off
    ((42, 42, 40, 55), -4, (185, 175, 170)),   # silver border, T/B off
    ((35, 48, 50, 40), 0, (160, 90, 20)),      # blue (back-like) border, both off
    ((45, 45, 46, 46), 7, (40, 205, 245)),     # centered, rotated more
]


def expected(l, r, t, b):
    return SideCentering(lr=max(l, r) / (l + r) * 100, tb=max(t, b) / (t + b) * 100)


@pytest.mark.parametrize("borders,angle,color", CASES)
@pytest.mark.parametrize("photo", [False, True])
def test_measured_centering_within_one_point(borders, angle, color, photo):
    img = make_card(*borders, border_bgr=color)
    if photo:
        img = place_on_background(img, angle)
    corners, _ = find_card(img)
    m = measure_borders(warp_card(img, corners, MARGIN), MARGIN)
    got = SideCentering.from_borders(m.borders)
    exp = expected(*borders)
    assert abs(got.lr - exp.lr) <= 1.0
    assert abs(got.tb - exp.tb) <= 1.0
    assert m.confidence > 0.6


def test_cropped_mode_uses_whole_image():
    img = make_card(40, 30, 45, 45)
    corners, _ = find_card(img, mode="cropped")
    assert corners[0].tolist() == [0, 0]
