"""SQLite history of graded cards."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .models import CardAssessment, GradeReport

DEFAULT_DB = Path(os.environ.get("CARDGRADER_DB", Path.cwd() / "data" / "cards.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    set_name TEXT NOT NULL,
    number TEXT NOT NULL,
    summary TEXT NOT NULL,
    assessment_json TEXT NOT NULL,
    report_json TEXT NOT NULL,
    front_thumb TEXT,
    back_thumb TEXT
)
"""


class CardStore:
    def __init__(self, path: Path | str = DEFAULT_DB):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def save(
        self,
        assessment: CardAssessment,
        report: GradeReport,
        front_thumb: str | None = None,
        back_thumb: str | None = None,
    ) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO cards (created_at, name, set_name, number, summary, assessment_json,"
                " report_json, front_thumb, back_thumb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    assessment.card.name,
                    assessment.card.set_name,
                    assessment.card.number,
                    report.summary,
                    assessment.model_dump_json(),
                    report.model_dump_json(),
                    front_thumb,
                    back_thumb,
                ),
            )
            return int(cur.lastrowid)

    def list(self, limit: int = 200) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, created_at, name, set_name, number, report_json, front_thumb"
                " FROM cards ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        out = []
        for r in rows:
            report = json.loads(r["report_json"])
            out.append(
                {
                    "id": r["id"],
                    "created_at": r["created_at"],
                    "name": r["name"],
                    "set_name": r["set_name"],
                    "number": r["number"],
                    "front_thumb": r["front_thumb"],
                    "best_fit": report["best_fit"],
                    "grades": {k: g["label"] for k, g in report["grades"].items()},
                }
            )
        return out

    def get(self, card_id: int) -> dict | None:
        with self._connect() as conn:
            r = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
        if r is None:
            return None
        return {
            "id": r["id"],
            "created_at": r["created_at"],
            "assessment": json.loads(r["assessment_json"]),
            "report": json.loads(r["report_json"]),
            "front_thumb": r["front_thumb"],
            "back_thumb": r["back_thumb"],
        }

    def delete(self, card_id: int) -> bool:
        with self._connect() as conn:
            return conn.execute("DELETE FROM cards WHERE id = ?", (card_id,)).rowcount > 0
