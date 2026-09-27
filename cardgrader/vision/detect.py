"""Find the card in a photo or scan and warp it into a flat, upright rectangle."""

from __future__ import annotations

import cv2
import numpy as np

# 63 x 88 mm TCG card at ~300 dpi
CARD_W, CARD_H = 750, 1048


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array(
        [pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32
    )


def _quad_candidates(gray: np.ndarray) -> list[np.ndarray]:
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    masks = []
    edges = cv2.Canny(blurred, 30, 100)
    masks.append(cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2))
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    masks += [otsu, 255 - otsu]

    quads = []
    for mask in masks:
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            approx = cv2.approxPolyDP(hull, 0.02 * peri, True)
            if len(approx) == 4:
                quads.append(approx)
            else:
                # Fall back to the minimum-area rectangle of the blob.
                quads.append(cv2.boxPoints(cv2.minAreaRect(hull)).astype(np.int32).reshape(4, 1, 2))
    return quads


def _full_image(w: int, h: int) -> np.ndarray:
    return np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)


def find_card(img: np.ndarray, mode: str = "auto") -> tuple[np.ndarray, float]:
    """Return the card's 4 corners (TL, TR, BR, BL) and a 0-1 confidence.

    ``mode="cropped"`` treats the whole image as the card. In ``auto`` mode the same
    happens when the image already has a card's aspect ratio (a tightly cropped scan)
    or when no plausible outline is found. Otherwise the inner artwork frame could be
    mistaken for the card.
    """
    h, w = img.shape[:2]
    target_aspect = CARD_H / CARD_W
    image_aspect = max(h, w) / min(h, w)
    if mode == "cropped" or (mode == "auto" and abs(image_aspect - target_aspect) / target_aspect < 0.025):
        return _full_image(w, h), 0.6
    scale = 1000.0 / max(h, w) if max(h, w) > 1000 else 1.0
    small = cv2.resize(img, None, fx=scale, fy=scale) if scale != 1.0 else img
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    sh, sw = gray.shape
    image_area = sh * sw

    best, best_score = None, 0.0
    for quad in _quad_candidates(gray):
        area = cv2.contourArea(quad)
        if area < 0.15 * image_area or area > 0.995 * image_area:
            continue
        rect = _order_corners(quad)
        width = (np.linalg.norm(rect[1] - rect[0]) + np.linalg.norm(rect[2] - rect[3])) / 2
        height = (np.linalg.norm(rect[3] - rect[0]) + np.linalg.norm(rect[2] - rect[1])) / 2
        if width == 0 or height == 0:
            continue
        aspect = max(width, height) / min(width, height)
        aspect_score = max(0.0, 1.0 - abs(aspect - target_aspect) / 0.25)
        score = aspect_score * (area / image_area) ** 0.25
        if score > best_score:
            best, best_score = rect, score

    if best is None:
        return _full_image(w, h), 0.3
    return best / scale, min(1.0, best_score + 0.1)


def warp_card(img: np.ndarray, corners: np.ndarray, margin: int = 0) -> np.ndarray:
    """Perspective-warp the card to CARD_W x CARD_H, portrait orientation.

    ``margin`` adds that many pixels of surrounding image on every side, so the real
    card edge can be found even when the detected outline is a few pixels off.
    """
    tl, tr, br, bl = corners
    width = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2
    height = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2
    if width > height:  # landscape photo of a portrait card: rotate the corner order
        corners = np.array([bl, tl, tr, br], dtype=np.float32)
    m = float(margin)
    dst = np.array(
        [[m, m], [m + CARD_W - 1, m], [m + CARD_W - 1, m + CARD_H - 1], [m, m + CARD_H - 1]], dtype=np.float32
    )
    matrix = cv2.getPerspectiveTransform(corners.astype(np.float32), dst)
    size = (CARD_W + 2 * margin, CARD_H + 2 * margin)
    return cv2.warpPerspective(img, matrix, size, flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
