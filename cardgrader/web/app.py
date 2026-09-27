"""FastAPI app: scan analysis, grading, and saved-card history."""

from __future__ import annotations

import base64
import os
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import criteria_loader
from ..engine import grade_all
from ..models import CORNER_LOCATIONS, EDGE_LOCATIONS, CardAssessment, GradeReport, SideCentering
from ..storage import CardStore
from ..vision import decode_image, find_card, measure_borders, warp_card
from .network import lan_addresses, qr_svg

HERE = Path(__file__).parent
MARGIN = 24  # px of surrounding photo kept around the warped card
MAX_UPLOAD = 25 * 1024 * 1024

app = FastAPI(title="Card Grading Estimator")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
store = CardStore()


def _data_url(img: np.ndarray, width: int | None = None, quality: int = 90) -> str:
    if width and img.shape[1] > width:
        img = cv2.resize(img, (width, int(img.shape[0] * width / img.shape[1])), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise HTTPException(500, "could not encode image")
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (HERE / "templates" / "index.html").read_text(encoding="utf-8")


@app.get("/apple-touch-icon.png", include_in_schema=False)
@app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
def apple_touch_icon() -> FileResponse:
    return FileResponse(HERE / "static" / "apple-touch-icon.png", media_type="image/png")


@app.get("/api/connect")
def connect(request: Request) -> dict:
    """How to open this app on a phone: LAN URLs plus a QR code for the first one."""
    lan_enabled = os.environ.get("CARDGRADER_LAN") == "1"
    port = request.url.port or int(os.environ.get("CARDGRADER_PORT", 8000))
    urls = [f"http://{ip}:{port}" for ip in lan_addresses()] if lan_enabled else []
    return {"lan_enabled": lan_enabled, "urls": urls, "qr_svg": qr_svg(urls[0]) if urls else None}


@app.get("/api/criteria")
def criteria() -> dict:
    defects = criteria_loader.defects()["types"]
    return {
        "locations": {
            "corners": list(CORNER_LOCATIONS),
            "edges": list(EDGE_LOCATIONS),
            "surface": ["surface"],
        },
        "severities": ["micro", "minor", "moderate", "major"],
        "defects": {
            key: {"label": spec["label"], "applies_to": spec["applies_to"], "caps": spec["caps"]}
            for key, spec in defects.items()
        },
        "companies": {
            name.upper(): {
                "sources": criteria_loader.company(name)["sources"],
                "last_verified": criteria_loader.company(name)["last_verified"],
            }
            for name in criteria_loader.COMPANIES
        },
    }


@app.post("/api/scan")
async def scan(file: UploadFile = File(...), mode: str = Form("auto")) -> dict:
    """Find the card in an uploaded scan or photo and measure its borders."""
    if mode not in ("auto", "cropped"):
        raise HTTPException(422, "mode must be 'auto' or 'cropped'")
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "image too large (25 MB max)")
    try:
        img = decode_image(data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    corners, card_conf = find_card(img, mode)
    warped = warp_card(img, corners, MARGIN)
    m = measure_borders(warped, MARGIN)
    h, w = warped.shape[:2]
    e = m.edges
    # Line positions in warped-image pixel coordinates, for the draggable overlay
    lines = {
        "outer": {"left": e["left"].outer, "right": w - e["right"].outer, "top": e["top"].outer, "bottom": h - e["bottom"].outer},
        "inner": {"left": e["left"].inner, "right": w - e["right"].inner, "top": e["top"].inner, "bottom": h - e["bottom"].inner},
    }
    centering = SideCentering.from_borders(m.borders)
    crop = warped[MARGIN : h - MARGIN, MARGIN : w - MARGIN]
    return {
        "image": _data_url(warped),
        "thumb": _data_url(crop, width=220, quality=80),
        "width": w,
        "height": h,
        "lines": lines,
        "borders": m.borders.model_dump(),
        "centering": centering.model_dump(),
        "confidence": {
            "card": round(float(card_conf), 3),
            "borders": m.confidence,
            "per_side": {s: round(x.confidence, 3) for s, x in e.items()},
        },
    }


@app.post("/api/grade", response_model=GradeReport)
def grade(assessment: CardAssessment) -> GradeReport:
    try:
        return grade_all(assessment)
    except KeyError as exc:
        raise HTTPException(422, str(exc)) from exc


class SaveRequest(BaseModel):
    assessment: CardAssessment
    front_thumb: str | None = None
    back_thumb: str | None = None


@app.post("/api/cards")
def save_card(req: SaveRequest) -> dict:
    report = grade(req.assessment)
    card_id = store.save(req.assessment, report, req.front_thumb, req.back_thumb)
    return {"id": card_id, "report": report}


@app.get("/api/cards")
def list_cards() -> list[dict]:
    return store.list()


@app.get("/api/cards/{card_id}")
def get_card(card_id: int) -> dict:
    card = store.get(card_id)
    if card is None:
        raise HTTPException(404, "card not found")
    return card


@app.delete("/api/cards/{card_id}")
def delete_card(card_id: int) -> dict:
    if not store.delete(card_id):
        raise HTTPException(404, "card not found")
    return {"deleted": card_id}


@app.post("/api/criteria/reload")
def reload_criteria() -> dict:
    """Re-read criteria/*.yaml after editing thresholds."""
    criteria_loader.reload()
    return {"reloaded": True}
