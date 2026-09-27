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
