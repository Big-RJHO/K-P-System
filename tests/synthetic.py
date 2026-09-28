"""Draw synthetic Pokémon-style cards with known border widths for tests and demos."""

from __future__ import annotations

import cv2
import numpy as np

W, H = 750, 1048


def make_card(
    left: int, right: int, top: int, bottom: int, border_bgr=(40, 205, 245), seed: int = 0, frame_bgr=(30, 30, 30)
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
    cv2.rectangle(inner, (0, 0), (inner.shape[1] - 1, inner.shape[0] - 1), frame_bgr, 3)
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


def place_in_clutter(card: np.ndarray, angle: float = 2.0, seed: int = 5) -> np.ndarray:
    """Card inside a clear sleeve on a busy desk: dark laptop-like area with keys, a wood-grain strip,
    long straight lines that run past the card, and a slightly lighter sleeve outline around the card."""
    rng = np.random.default_rng(seed)
    bh, bw = int(H * 1.6), int(W * 1.7)
    bg = np.full((bh, bw, 3), 40, np.uint8)
    bg[: bh // 5] = (70, 45, 60)  # keyboard area
    for x in range(20, bw - 100, 160):  # keys
        cv2.rectangle(bg, (x, 20), (x + 130, bh // 5 - 30), (35, 25, 30), -1)
        cv2.rectangle(bg, (x, 20), (x + 130, bh // 5 - 30), (110, 90, 100), 2)
    cv2.line(bg, (0, bh // 5 + 40), (bw, bh // 5 + 40), (90, 90, 90), 3)  # laptop edge, runs past the card
    grain = bg[int(bh * 0.86):]
    grain[:] = (40, 60, 80)
    for y in range(0, grain.shape[0], 9):  # wood grain
        grain[y : y + 2] = (70, 95, 120)
    bg = np.clip(bg.astype(np.int16) + rng.normal(0, 4, bg.shape), 0, 255).astype(np.uint8)
    center = (bw / 2, bh / 2)
    # sleeve: slightly larger, faintly lighter rectangle with a thin bright edge
    sleeve = np.zeros((H + 60, W + 50, 3), np.uint8)
    matrix_s = cv2.getRotationMatrix2D(((W + 50) / 2, (H + 60) / 2), angle, 1.0)
    matrix_s[0, 2] += center[0] - (W + 50) / 2
    matrix_s[1, 2] += center[1] - (H + 60) / 2 - 15
    smask = cv2.warpAffine(np.full(sleeve.shape[:2], 255, np.uint8), matrix_s, (bw, bh))
    bg[smask > 0] = np.clip(bg[smask > 0].astype(np.int16) + 12, 0, 255).astype(np.uint8)
    edge = cv2.morphologyEx(smask, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    bg[edge > 0] = (200, 200, 200)
    matrix = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
    matrix[0, 2] += center[0] - W / 2
    matrix[1, 2] += center[1] - H / 2
    warped = cv2.warpAffine(card, matrix, (bw, bh), flags=cv2.INTER_CUBIC)
    mask = cv2.warpAffine(np.full((H, W), 255, np.uint8), matrix, (bw, bh), flags=cv2.INTER_NEAREST)
    bg[mask > 0] = warped[mask > 0]
    return bg



def tilt_photo(img: np.ndarray, amount: float = 0.06, seed: int = 3) -> np.ndarray:
    """Simulate a phone held off-angle: a keystone (perspective) distortion of the whole photo."""
    rng = np.random.default_rng(seed)
    h, w = img.shape[:2]
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    jitter = rng.uniform(-1, 1, (4, 2)) * amount * np.array([w, h]) * 0.5
    jitter[0] += [amount * w, 0]  # narrower at the top, like tilting the phone back
    jitter[1] -= [amount * w, 0]
    dst = (src + jitter).astype(np.float32)
    return cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h), borderMode=cv2.BORDER_REPLICATE)
