"""The owner has TAG's written permission to collect TAG reports and images for personal research. TAG data
(reports, scans, cert lists) stays outside this repository; only code lives here.

Make a TAG card scan look like a photo of the card on a dark background, so the program reads it as usual.

TAG's scans show the card on an even orange background: a strip of about 15 px (at 1800 px tall) along the
edges, and more in the rounded corners. This finds that background by its colour (the median of the four
image corners), keeps only the parts connected to the image border, paints them dark and pads a dark margin.
A worn, extra-rounded corner then shows background where card is missing, as it would in a photo. The card
itself (yellow, white or any border) is far from the orange in colour, so it isn't touched.

  .venv/bin/python -I tagprep.py DATA_DIR OUT_DIR [CERT ...]   ->  OUT_DIR/<cert>/{front,back}.jpg
"""
import sys
from pathlib import Path

import cv2
import numpy as np

BG = (24, 24, 26)
data, out = Path(sys.argv[1]), Path(sys.argv[2])
certs = sys.argv[3:] or sorted(d.name for d in data.iterdir() if d.is_dir() and (d / "front.jpg").exists())


def prep(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    lab = cv2.cvtColor(cv2.GaussianBlur(img, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    p = max(4, h // 150)
    bg = np.median(np.concatenate([lab[:p, :p], lab[:p, -p:], lab[-p:, :p], lab[-p:, -p:]]).reshape(-1, 3), axis=0)
    near = (np.linalg.norm(lab - bg, axis=2) < 22).astype(np.uint8)
    n, labels = cv2.connectedComponents(near, connectivity=4)
    edge_ids = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    mask = np.isin(labels, list(edge_ids)).astype(np.uint8)
    # The card's outline is anti-aliased against the orange: take 2 more px so no orange fringe is left.
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8)).astype(bool)
    work = img.copy()
    work[mask] = BG
    m = int(round(0.08 * w))
    return cv2.copyMakeBorder(work, m, m, m, m, cv2.BORDER_CONSTANT, value=BG)


for cert in certs:
    (out / cert).mkdir(parents=True, exist_ok=True)
    for side in ("front", "back"):
        src = data / cert / f"{side}.jpg"
        img = cv2.imread(str(src), cv2.IMREAD_COLOR) if src.exists() else None
        if img is None:
            print(cert, side, "missing")
            continue
        cv2.imwrite(str(out / cert / f"{side}.jpg"), prep(img), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(cert, "ok")
