"""Measure border widths (outer card edge to inner frame) on a warped card image."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from ..models import Borders

SIDES = ("left", "right", "top", "bottom")


@dataclass
class SideEdges:
    outer: float  # distance from the image edge to the card's physical edge
    inner: float  # distance from the image edge to the inner (artwork) frame
    confidence: float

    @property
    def width(self) -> float:
        return self.inner - self.outer


@dataclass
class BorderMeasurement:
    borders: Borders
    confidence: float
    edges: dict[str, SideEdges]


def _profiles(lab: np.ndarray, side: str, depth: int) -> np.ndarray:
    """Profiles running inward from one image edge: shape (n_lines, depth, 3).

    Lines are taken from the middle 20-80% of the side so rounded corners are skipped.
    """
    h, w = lab.shape[:2]
    if side == "left":
        return lab[int(h * 0.2) : int(h * 0.8), :depth]
    if side == "right":
        return lab[int(h * 0.2) : int(h * 0.8), w - depth :][:, ::-1]
    if side == "top":
        return lab[:depth, int(w * 0.2) : int(w * 0.8)].transpose(1, 0, 2)
    return lab[h - depth :, int(w * 0.2) : int(w * 0.8)][::-1].transpose(1, 0, 2)


def _first_run(mask: np.ndarray, run: int) -> tuple[np.ndarray, np.ndarray]:
    """Index of the first `run` consecutive True values in each row, plus whether one was found."""
    if mask.shape[1] < run:
        return np.zeros(mask.shape[0]), np.zeros(mask.shape[0], bool)
    window = np.lib.stride_tricks.sliding_window_view(mask, run, axis=1).all(axis=2)
    return window.argmax(axis=1).astype(np.float32), window.any(axis=1)


def _measure_side(lab: np.ndarray, side: str, margin: int) -> SideEdges:
    h, w = lab.shape[:2]
    extent = (w if side in ("left", "right") else h) - 2 * margin
    depth = margin + int(extent * 0.22)
    prof = _profiles(lab, side, depth).astype(np.float32)
    n_lines = prof.shape[0]

    # Sample the border colour a little way in from the expected card edge.
    ref_start = margin + int(extent * 0.012)
    ref_end = margin + int(extent * 0.03)
    ref = np.median(prof[:, ref_start:ref_end].reshape(-1, 3), axis=0)
    dist = np.linalg.norm(prof - ref, axis=2)  # (n_lines, depth)
    spread = float(np.median(dist[:, ref_start:ref_end]))
    over = dist > max(18.0, 4.0 * spread)

    # Inner frame: first sustained change going inward from the reference strip.
    inner_rel, inner_found = _first_run(over[:, ref_end:], 3)
    inner = inner_rel + ref_end

    # Outer edge: first sustained change going outward from the reference strip.
    outward = over[:, :ref_start][:, ::-1]
    outer_rel, outer_found = _first_run(outward, 2)
    outer = np.where(outer_found, ref_start - outer_rel, float(margin))

    if inner_found.sum() < max(5, n_lines * 0.2):
        return SideEdges(outer=float(margin), inner=float("nan"), confidence=0.0)
    widths = (inner - outer)[inner_found]
    median = float(np.median(widths))
    iqr = float(np.subtract(*np.percentile(widths, [75, 25])))
    consistency = max(0.0, 1.0 - iqr / max(4.0, median * 0.25))
    return SideEdges(
        outer=float(np.median(outer[inner_found])),
        inner=float(np.median(inner[inner_found])),
        confidence=float(inner_found.mean()) * consistency,
    )


def measure_borders(card: np.ndarray, margin: int = 0) -> BorderMeasurement:
    """Estimate the four border widths (pixels) of a warped, upright card image.

    ``margin`` is the padding added by :func:`warp_card` around the detected outline.
    """
    blurred = cv2.GaussianBlur(card, (3, 3), 0)
    lab = cv2.cvtColor(blurred, cv2.COLOR_BGR2LAB)
    h, w = card.shape[:2]
    edges: dict[str, SideEdges] = {}
    for side in SIDES:
        e = _measure_side(lab, side, margin)
        if np.isnan(e.inner):  # full-art card or no clear frame: guess a typical border
            extent = (w if side in ("left", "right") else h) - 2 * margin
            e = SideEdges(outer=e.outer, inner=e.outer + extent * 0.05, confidence=0.0)
        edges[side] = e
    return BorderMeasurement(
        borders=Borders(**{s: round(e.width, 1) for s, e in edges.items()}),
        confidence=round(min(e.confidence for e in edges.values()), 3),
        edges=edges,
    )
