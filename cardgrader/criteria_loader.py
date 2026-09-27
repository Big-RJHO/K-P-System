"""Load the per-company criteria and defect catalog from ``criteria/*.yaml``."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

CRITERIA_DIR = Path(__file__).parent / "criteria"
COMPANIES = ("psa", "bgs", "cgc", "tag")


def _read(name: str) -> dict[str, Any]:
    with open(CRITERIA_DIR / f"{name}.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _normalize_labels(data: dict[str, Any]) -> None:
    if "labels" in data:
        data["labels"] = {float(k): v for k, v in data["labels"].items()}


@lru_cache(maxsize=None)
def company(name: str) -> dict[str, Any]:
    data = _read(name.lower())
    _normalize_labels(data)
    return data


@lru_cache(maxsize=None)
def defects() -> dict[str, Any]:
    return _read("defects")


def defect_type(key: str) -> dict[str, Any]:
    types = defects()["types"]
    if key not in types:
        raise KeyError(f"unknown defect type {key!r}")
    return types[key]


def reload() -> None:
    """Drop cached criteria so edited YAML is picked up without restarting."""
    company.cache_clear()
    defects.cache_clear()
