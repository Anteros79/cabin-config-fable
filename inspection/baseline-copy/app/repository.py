"""Replaceable read-only adapter for a future approved configuration feed."""
import json
import sqlite3
from contextlib import closing, contextmanager
from typing import Protocol


class CabinRepository(Protocol):
    def aircraft(self, tail: str) -> dict | None: ...
    def aircraft_list(self) -> list[dict]: ...
    def configurations(self, tail: str, day: str) -> list[dict]: ...
    def variants(self) -> list[dict]: ...
    def positions(self, variant_id: str) -> list[dict]: ...
    def rules(self) -> list[dict]: ...
    def document(self, doc_id: str) -> dict | None: ...
    def substitutes(self, rule_id: str) -> list[dict]: ...


class SQLiteRepository:
    def __init__(self, path, connection=None):
        self.path = path.resolve()
        self.connection = connection

    @contextmanager
    def snapshot(self):
        with closing(sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            yield SQLiteRepository(self.path, db)

    def _query(self, sql, args=()):
        if self.connection is not None:
            return [dict(r) for r in self.connection.execute(sql, args)]
        with self.snapshot() as reader:
            return reader._query(sql, args)

    def aircraft(self, tail):
        rows = self._query("SELECT * FROM aircraft WHERE tail=?", (tail,))
        return rows[0] if rows else None

    def aircraft_list(self):
        return self._query("SELECT * FROM aircraft ORDER BY tail")

    def configurations(self, tail, day):
        return self._query("SELECT * FROM tail_config WHERE tail=? AND eff_from<=? AND (eff_to IS NULL OR eff_to>=?)", (tail, day, day))

    def variants(self):
        rows = self._query("SELECT * FROM variant ORDER BY id")
        for r in rows:
            r["seats"] = json.loads(r["seats"])
        return rows

    def positions(self, variant_id):
        return self._query("SELECT p.* FROM position p JOIN variant_position v ON v.position_id=p.id WHERE v.variant_id=? ORDER BY p.id", (variant_id,))

    def rules(self):
        rows = self._query("SELECT * FROM part_rule ORDER BY id")
        for r in rows:
            r["selectors"] = json.loads(r["selectors"])
        return rows

    def document(self, doc_id):
        rows = self._query("SELECT * FROM source_doc WHERE id=?", (doc_id,))
        return rows[0] if rows else None

    def substitutes(self, rule_id):
        rows = self._query("SELECT * FROM substitute WHERE rule_id=? ORDER BY id", (rule_id,))
        for r in rows:
            r["with_panels"] = self._query("SELECT part_no,qty FROM substitute_panel WHERE substitute_id=? ORDER BY part_no", (r["id"],))
        return rows
