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


def card_mask(radius: int = 36) -> np.ndarray:
    """Card shape with rounded corners (real cards have a ~3 mm corner radius, 36 px at this scale)."""
    mask = np.zeros((H, W), np.uint8)
    cv2.rectangle(mask, (radius, 0), (W - 1 - radius, H - 1), 255, -1)
    cv2.rectangle(mask, (0, radius), (W - 1, H - 1 - radius), 255, -1)
    for cx, cy in ((radius, radius), (W - 1 - radius, radius), (radius, H - 1 - radius), (W - 1 - radius, H - 1 - radius)):
        cv2.circle(mask, (cx, cy), radius, 255, -1)
    return mask


def place_on_background(
    card: np.ndarray, angle: float = 3.0, seed: int = 1, bg: int = 35, mask: np.ndarray | None = None
) -> np.ndarray:
    """Rotate the card and paste it onto a larger, noisy dark background, like a photo.
    `mask` replaces the card's shape (default: `card_mask()`), e.g. with worn corners."""
    rng = np.random.default_rng(seed)
    bh, bw = int(H * 1.5), int(W * 1.6)
    bg = np.clip(rng.normal(bg, 10, (bh, bw, 3)), 0, 255).astype(np.uint8)
    center = (bw / 2, bh / 2)
    matrix = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
    matrix[0, 2] += center[0] - W / 2
    matrix[1, 2] += center[1] - H / 2
    warped = cv2.warpAffine(card, matrix, (bw, bh), flags=cv2.INTER_CUBIC, borderValue=(0, 0, 0))
    mask = cv2.warpAffine(card_mask() if mask is None else mask, matrix, (bw, bh), flags=cv2.INTER_NEAREST)
    bg[mask > 0] = warped[mask > 0]
    return bg


def encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def place_in_clutter(
    card: np.ndarray, angle: float = 2.0, seed: int = 5, sleeve_pad: tuple[int, int] = (50, 60), sleeve_light: int = 12
) -> np.ndarray:
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
    pw, ph = sleeve_pad
    sleeve = np.zeros((H + ph, W + pw, 3), np.uint8)
    matrix_s = cv2.getRotationMatrix2D(((W + pw) / 2, (H + ph) / 2), angle, 1.0)
    matrix_s[0, 2] += center[0] - (W + pw) / 2
    matrix_s[1, 2] += center[1] - (H + ph) / 2 - 15
    smask = cv2.warpAffine(np.full(sleeve.shape[:2], 255, np.uint8), matrix_s, (bw, bh))
    bg[smask > 0] = np.clip(bg[smask > 0].astype(np.int16) + sleeve_light, 0, 255).astype(np.uint8)
    edge = cv2.morphologyEx(smask, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    bg[edge > 0] = (200, 200, 200)
    matrix = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
    matrix[0, 2] += center[0] - W / 2
    matrix[1, 2] += center[1] - H / 2
    warped = cv2.warpAffine(card, matrix, (bw, bh), flags=cv2.INTER_CUBIC)
    mask = cv2.warpAffine(card_mask(), matrix, (bw, bh), flags=cv2.INTER_NEAREST)
    bg[mask > 0] = warped[mask > 0]
    return bg


def card_mask_worn(radius: int = 36, worn: dict[str, int] | None = None, fray: float = 0.0, seed: int = 0) -> np.ndarray:
    """Card shape where some corners are worn rounder: `worn` maps a corner ("top_left", ...) to its radius.
    `fray` (px) roughens those corners' outlines."""
    worn = worn or {}
    rng = np.random.default_rng(seed)
    mask = card_mask(radius)
    centers = {"top_left": (1, 1), "top_right": (-1, 1), "bottom_right": (-1, -1), "bottom_left": (1, -1)}
    for corner, r in worn.items():
        sx, sy = centers[corner]
        x0 = 0 if sx > 0 else W - 1
        y0 = 0 if sy > 0 else H - 1
        cx, cy = x0 + sx * r, y0 + sy * r
        for v in range(r + 1):
            for u in range(r + 1):
                x, y = x0 + sx * u, y0 + sy * v
                d = np.hypot(x - cx, y - cy)
                jitter = rng.uniform(-fray, fray) if fray else 0.0
                if u < r and v < r and d > r + jitter:
                    mask[y, x] = 0
    return mask


def paint_edge_whitening(
    card: np.ndarray, side: str, start: int, length: int, depth: int, seed: int = 0, color=(238, 240, 242)
) -> np.ndarray:
    """Paint exposed white card stock along one edge: `length` px starting `start` px along the edge
    (top/bottom from the left, left/right from the top), reaching up to `depth` px in (ragged)."""
    rng = np.random.default_rng(seed)
    out = card.copy()
    for t in range(start, start + length):
        d = int(rng.integers(max(1, depth // 2), depth + 1))
        if side == "top":
            out[0:d, t] = color
        elif side == "bottom":
            out[H - d : H, t] = color
        elif side == "left":
            out[t, 0:d] = color
        else:
            out[t, W - d : W] = color
    return out


def paint_corner_whitening(card: np.ndarray, corner: str, depth: int = 6, radius: int = 36, seed: int = 0, color=(238, 240, 242)) -> np.ndarray:
    """Paint a frayed white band just inside a rounded corner's arc (a worn, whitened corner)."""
    rng = np.random.default_rng(seed)
    out = card.copy()
    sx, sy = {"top_left": (1, 1), "top_right": (-1, 1), "bottom_right": (-1, -1), "bottom_left": (1, -1)}[corner]
    x0 = 0 if sx > 0 else W - 1
    y0 = 0 if sy > 0 else H - 1
    cx, cy = x0 + sx * radius, y0 + sy * radius
    for ang in np.linspace(0, np.pi / 2, 200):
        d = rng.uniform(depth / 2, depth)
        for rr in np.arange(radius - d, radius + 0.5, 0.5):
            x = int(round(cx - sx * rr * np.cos(ang)))
            y = int(round(cy - sy * rr * np.sin(ang)))
            if 0 <= x < W and 0 <= y < H:
                out[y, x] = color
    return out


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
