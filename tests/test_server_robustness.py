"""The local server under load and failure: the scan endpoint must not block the event loop or read
oversized uploads whole, and the card history must close every SQLite connection it opens."""

from __future__ import annotations

import asyncio
import sqlite3
import time

import pytest
from fastapi import HTTPException

from cardgrader import storage
from cardgrader.storage import CardStore
from cardgrader.web import app as webapp


class FakeUpload:
    """Stands in for UploadFile: serves `data` and records how many bytes the endpoint asked for and got."""

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.returned = 0
        self.sizes: list[int] = []

    async def read(self, size: int = -1) -> bytes:
        self.sizes.append(size)
        end = len(self.data) if size is None or size < 0 else min(len(self.data), self.pos + size)
        chunk = self.data[self.pos : end]
        self.pos = end
        self.returned += len(chunk)
        return chunk


def test_scan_runs_image_work_off_the_event_loop(monkeypatch):
    def slow_analysis(data, mode):
        time.sleep(0.6)  # stands in for decoding, detection, warping, measuring and JPEG encoding
        return {"ok": True, "mode": mode}

    monkeypatch.setattr(webapp, "_analyse_scan", slow_analysis)

    async def main():
        ticks: list[float] = []

        async def ticker():
            while True:
                ticks.append(time.perf_counter())
                await asyncio.sleep(0.01)

        t = asyncio.create_task(ticker())
        await asyncio.sleep(0)
        start = time.perf_counter()
        result = await webapp.scan(file=FakeUpload(b"x" * 100), mode="auto")
        elapsed = time.perf_counter() - start
        t.cancel()
        during = [x for x in ticks if start <= x <= start + elapsed]
        gaps = [b - a for a, b in zip(during, during[1:])]
        return result, elapsed, during, gaps

    result, elapsed, during, gaps = asyncio.run(main())
    assert result == {"ok": True, "mode": "auto"}
    assert elapsed >= 0.55
    # The loop kept running while the scan worked: many ticks, and no stall anywhere near the scan's length.
    assert len(during) >= 10
    assert max(gaps) < 0.3


def test_oversized_upload_is_rejected_after_reading_at_most_limit_plus_one(monkeypatch):
    monkeypatch.setattr(webapp, "MAX_UPLOAD", 1000)
    called = []
    monkeypatch.setattr(webapp, "_analyse_scan", lambda data, mode: called.append(len(data)) or {})
    big = FakeUpload(b"x" * 50_000)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(webapp.scan(file=big, mode="auto"))
    assert exc.value.status_code == 413
    assert big.returned <= 1001 and big.sizes == [1001]
    assert called == []

    # Exactly at the limit is still accepted.
    ok = FakeUpload(b"x" * 1000)
    asyncio.run(webapp.scan(file=ok, mode="auto"))
    assert called == [1000]


def test_oversized_upload_rejected_through_http(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(webapp, "MAX_UPLOAD", 1000)
    monkeypatch.setattr(webapp, "store", CardStore(tmp_path / "cards.db"))
    client = TestClient(webapp.app)
    res = client.post("/api/scan", files={"file": ("big.png", b"x" * 5000, "image/png")}, data={"mode": "auto"})
    assert res.status_code == 413
    res = client.post("/api/scan", files={"file": ("junk.png", b"not an image", "image/png")}, data={"mode": "auto"})
    assert res.status_code == 422   # errors raised in the worker thread still reach the client


class TrackingConnect:
    """Wraps sqlite3.connect and keeps every connection it opens."""

    def __init__(self):
        self.conns: list[sqlite3.Connection] = []
        self.real = sqlite3.connect

    def __call__(self, *a, **kw):
        conn = self.real(*a, **kw)
        self.conns.append(conn)
        return conn


def _closed(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT 1")
    except sqlite3.ProgrammingError:
        return True
    return False


def test_store_closes_every_connection(monkeypatch, tmp_path):
    from helpers import card

    from cardgrader.engine import grade_all

    track = TrackingConnect()
    monkeypatch.setattr(storage.sqlite3, "connect", track)
    store = CardStore(tmp_path / "cards.db")
    a = card()
    card_id = store.save(a, grade_all(a))
    assert store.list()[0]["id"] == card_id
    assert store.get(card_id)["id"] == card_id
    assert store.get(card_id + 99) is None
    assert store.delete(card_id) is True
    assert len(track.conns) == 6
    assert all(_closed(c) for c in track.conns)


def test_store_connection_commits_or_rolls_back_and_closes(monkeypatch, tmp_path):
    track = TrackingConnect()
    monkeypatch.setattr(storage.sqlite3, "connect", track)
    store = CardStore(tmp_path / "cards.db")
    insert = (
        "INSERT INTO cards (created_at, name, set_name, number, summary, assessment_json, report_json)"
        " VALUES ('t', ?, '', '', '', '{}', '{}')"
    )

    with store._connect() as conn:
        conn.execute(insert, ("kept",))
    assert _closed(track.conns[-1])

    with pytest.raises(RuntimeError):
        with store._connect() as conn:
            conn.execute(insert, ("rolled back",))
            raise RuntimeError("boom")
    assert _closed(track.conns[-1])

    with store._connect() as conn:
        names = [r["name"] for r in conn.execute("SELECT name FROM cards")]
    assert names == ["kept"]
    assert all(_closed(c) for c in track.conns)
