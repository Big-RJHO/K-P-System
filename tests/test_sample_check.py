"""The scoring helpers of scripts/sample_check.py (the end-to-end check on graded sample slabs)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sample_check", ROOT / "scripts" / "sample_check.py")
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)


def test_names_match_across_spelling_and_script():
    names = ["Sabrina's Gengar", "ナツメのゲンガー"]
    assert sc.name_ok("Sabrina’s Gengar", names)       # curly apostrophe
    assert sc.name_ok("ナツメのゲンガー", names)
    assert sc.name_ok("Charizard", ["Charizard"])
    assert not sc.name_ok("Gengar Ex", names)
    assert not sc.name_ok("", names)


def test_numbers_compare_the_printed_left_part():
    assert sc.number_ok("004/102", "4/102") and sc.number_ok("4", "4/102")
    assert sc.number_ok("94", "4/102") is False
    assert sc.number_ok("094", "") is None   # nothing printed to check (vintage Japanese cards)


def test_report_centering_becomes_the_larger_share_per_axis():
    assert sc.centering_share("57L/43R 54T/46B") == (57, 54)
    assert sc.centering_share("49L/51R 55T/45B") == (51, 55)
    assert sc.centering_share("") is None and sc.centering_share("50L/50R") is None
