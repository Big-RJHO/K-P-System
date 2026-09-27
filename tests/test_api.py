import pytest
from fastapi.testclient import TestClient

from synthetic import encode_png, make_card, place_on_background


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from cardgrader.storage import CardStore
    from cardgrader.web import app as webapp

    monkeypatch.setattr(webapp, "store", CardStore(tmp_path / "cards.db"))
    return TestClient(webapp.app)


def test_index_and_criteria(client):
    assert "Card Grading Lab" in client.get("/").text
    crit = client.get("/api/criteria").json()
    assert "corner_whitening" in crit["defects"]
    assert set(crit["companies"]) == {"PSA", "BGS", "CGC", "TAG"}


def test_scan_grade_save_list(client):
    png = encode_png(place_on_background(make_card(40, 30, 45, 45), 3))
    scan = client.post("/api/scan", files={"file": ("front.png", png, "image/png")}, data={"mode": "auto"}).json()
    assert scan["image"].startswith("data:image/jpeg;base64,")
    assert abs(scan["centering"]["lr"] - 57.1) <= 1.0
    assert scan["lines"]["inner"]["left"] > scan["lines"]["outer"]["left"]

    assessment = {
        "card": {"name": "Pikachu", "set_name": "Base Set", "number": "58/102"},
        "centering": {"front": scan["centering"], "back": {"lr": 60, "tb": 52}},
        "defects": [{"side": "back", "location": "top_right", "type": "corner_whitening", "severity": "minor"}],
    }
    report = client.post("/api/grade", json=assessment).json()
    assert report["grades"]["PSA"]["grade"] == 9

    saved = client.post("/api/cards", json={"assessment": assessment, "front_thumb": scan["thumb"]}).json()
    listing = client.get("/api/cards").json()
    assert listing[0]["id"] == saved["id"] and listing[0]["name"] == "Pikachu"
    full = client.get(f"/api/cards/{saved['id']}").json()
    assert full["assessment"]["card"]["number"] == "58/102"
    assert client.delete(f"/api/cards/{saved['id']}").status_code == 200
    assert client.get(f"/api/cards/{saved['id']}").status_code == 404


def test_bad_inputs(client):
    assert client.post("/api/scan", files={"file": ("x.png", b"not an image", "image/png")}).status_code == 422
    bad = {"defects": [{"side": "front", "location": "surface", "type": "nope", "severity": "minor"}]}
    assert client.post("/api/grade", json=bad).status_code == 422
    bad_loc = {"defects": [{"side": "front", "location": "middle", "type": "stain", "severity": "minor"}]}
    assert client.post("/api/grade", json=bad_loc).status_code == 422


def test_connect_info(client, monkeypatch):
    monkeypatch.setenv("CARDGRADER_LAN", "0")
    assert client.get("/api/connect").json() == {"lan_enabled": False, "urls": [], "qr_svg": None}

    from cardgrader.web import app as webapp

    monkeypatch.setenv("CARDGRADER_LAN", "1")
    monkeypatch.setattr(webapp, "lan_addresses", lambda: ["192.168.1.20"])
    info = client.get("/api/connect").json()
    assert info["urls"][0].startswith("http://192.168.1.20:")
    assert info["qr_svg"].startswith("<svg")


def test_qr_code_decodes():
    import cv2
    import numpy as np

    from cardgrader.web.network import qr_svg

    url = "http://192.168.1.20:8000"
    svg = qr_svg(url, module=8)
    # Rasterise the SVG's rects and read it back with OpenCV's detector.
    import re

    size = int(re.search(r'viewBox="0 0 (\d+)', svg).group(1))
    img = np.full((size, size), 255, np.uint8)
    for x, y in re.findall(r'<rect x="(\d+)" y="(\d+)" width="8"', svg):
        img[int(y) : int(y) + 8, int(x) : int(x) + 8] = 0
    assert cv2.QRCodeDetector().detectAndDecode(img)[0] == url


def test_home_screen_assets(client):
    assert client.get("/apple-touch-icon.png").headers["content-type"] == "image/png"
    assert client.get("/static/manifest.webmanifest").status_code == 200
    html = client.get("/").text
    assert 'capture="environment"' in html and "apple-mobile-web-app-capable" in html
