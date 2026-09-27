"""Draw synthetic Pokémon-style cards with known border widths for tests and demos."""

from __future__ import annotations

import cv2
import numpy as np

W, H = 750, 1048


def make_card(
    left: int, right: int, top: int, bottom: int, border_bgr=(40, 205, 245), seed: int = 0
) -> np.ndarray:
    """Card with a solid border and a busy 'artwork' area inside the given border widths."""
    rng = np.random.default_rng(seed)
    card = np.zeros((H, W, 3), np.uint8)
    card[:] = border_bgr
    # Border texture noise, similar to print grain
    card = np.clip(card.astype(np.int16) + rng.normal(0, 3, card.shape), 0, 255).astype(np.uint8)
    inner = card[top : H - bottom, left : W - right]
    inner[:] = (70, 60, 150)
    for _ in range(60):
        c = tuple(int(x) for x in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, inner.shape[1])), int(rng.integers(0, inner.shape[0]))
        cv2.circle(inner, (x, y), int(rng.integers(10, 80)), c, -1)
    cv2.rectangle(inner, (0, 0), (inner.shape[1] - 1, inner.shape[0] - 1), (30, 30, 30), 3)
    return card


def place_on_background(card: np.ndarray, angle: float = 3.0, seed: int = 1, bg: int = 35) -> np.ndarray:
    """Rotate the card and paste it onto a larger, noisy dark background, like a photo."""
    rng = np.random.default_rng(seed)
    bh, bw = int(H * 1.5), int(W * 1.6)
    bg = np.clip(rng.normal(bg, 10, (bh, bw, 3)), 0, 255).astype(np.uint8)
    center = (bw / 2, bh / 2)
    matrix = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
    matrix[0, 2] += center[0] - W / 2
    matrix[1, 2] += center[1] - H / 2
    warped = cv2.warpAffine(card, matrix, (bw, bh), flags=cv2.INTER_CUBIC, borderValue=(0, 0, 0))
    mask = cv2.warpAffine(np.full((H, W), 255, np.uint8), matrix, (bw, bh), flags=cv2.INTER_NEAREST)
    bg[mask > 0] = warped[mask > 0]
    return bg


def encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()
