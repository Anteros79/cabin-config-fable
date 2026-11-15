"""Transactional appearance visits with immutable completed records."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import uuid4


class VisitError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(UTC).isoformat()


def applies(p, s):
    return (p["category"] == "SEAT" and p["zone"] == s["zone"]
        and p["row_from"] <= s["row"] <= p["row_to"] and p["side"] == s["side"]
        and p["seat_pos"] in (s["letter"], "ALL")
        and bool(p["exit_row"]) == bool(s["exit_row"])
        and (not p["seat_group"] or p["seat_group"] == s["seat_group"]))


class VisitStore:
    def __init__(self, path):
        self.path = path

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS visits (
                  id TEXT PRIMARY KEY, tail TEXT NOT NULL, check_date TEXT NOT NULL,
                  technician TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
                  created_at TEXT NOT NULL, completed_at TEXT, snapshot TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS replacements (
                  id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visits(id),
                  location TEXT NOT NULL, component TEXT NOT NULL, payload TEXT NOT NULL,
                  UNIQUE(visit_id,location,component)
                );
            """)

    def _visit(self, db, id_):
        row = db.execute("SELECT * FROM visits WHERE id=?", (id_,)).fetchone()
        if not row:
            raise VisitError("Visit not found.", 404)
        return dict(row)

    def create(self, lookup, technician):
        if lookup["status"] not in ("OK", "PARTIAL"):
            raise VisitError(lookup["message"], 422)
        id_ = str(uuid4())
        with self.connect() as db:
            db.execute("INSERT INTO visits(id,tail,check_date,technician,created_at,snapshot) VALUES(?,?,?,?,?,?)",
                       (id_, lookup["tail"], lookup["check_date"], technician.strip(), now(), json.dumps(lookup)))
        return self.get(id_)

    def get(self, id_):
        with self.connect() as db:
            db.execute("BEGIN")
            visit = self._visit(db, id_)
            visit["snapshot"] = json.loads(visit["snapshot"])
            visit["replacements"] = [json.loads(r["payload"]) | {"id": r["id"]} for r in db.execute("SELECT * FROM replacements WHERE visit_id=? ORDER BY rowid", (id_,))]
        return visit

    def list(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT v.id,v.tail,v.check_date,v.technician,v.status,v.created_at,v.completed_at,(SELECT count(*) FROM replacements r WHERE r.visit_id=v.id) AS item_count FROM visits v ORDER BY created_at DESC LIMIT 100")]

    def add(self, id_, location, rule_id, substitute_id, quantity, note):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            visit = self._visit(db, id_)
            if visit["status"] != "DRAFT":
                raise VisitError("Completed visits are locked.")
            snapshot = json.loads(visit["snapshot"])
            line = next((r for r in snapshot["lines"] if r["id"] == rule_id), None)
            if not line:
                raise VisitError("Part rule is not applicable to this visit.", 422)
            p = line["position"]
            if p["category"] == "SEAT":
                seat = next((s for s in snapshot["configuration"]["variant"]["seats"] if s["id"] == location), None)
                if not seat or not applies(p, seat):
                    raise VisitError("This part does not apply to this seat.", 422)
                if quantity != 1:
                    raise VisitError("Record one replacement per seat component.", 422)
            elif location != p["panel_loc"]:
                raise VisitError("This part does not apply to this cabin location.", 422)
            chosen = line
            if substitute_id:
                chosen = next((s for s in line["substitutes"] if s["id"] == substitute_id), None)
                if not chosen:
                    raise VisitError("Substitute is not approved on this visit's check date.", 422)
            parts = [{"part_no": chosen.get("alt_part_no", chosen.get("part_no")), "qty": chosen["qty"] * quantity, "unit": chosen["unit"]}]
            parts.extend({"part_no": p["part_no"], "qty": p["qty"] * quantity, "unit": "PANEL"} for p in chosen.get("with_panels", []))
            payload = {"location": location, "component": p["component"], "description": p["label"],
                "rule_id": rule_id, "substitute_id": substitute_id, "quantity": quantity,
                "parts": parts, "source": chosen["source"], "primary_source": line["source"],
                "pending_change": bool(line["pending_change"]), "change_note": line["change_note"],
                "note": note.strip(), "recorded_at": now()}
            db.execute("INSERT INTO replacements VALUES(?,?,?,?,?) ON CONFLICT(visit_id,location,component) DO UPDATE SET payload=excluded.payload",
                       (str(uuid4()), id_, location, p["component"], json.dumps(payload)))
        return self.get(id_)

    def remove(self, id_, item_id):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._visit(db, id_)["status"] != "DRAFT":
                raise VisitError("Completed visits are locked.")
            r = db.execute("DELETE FROM replacements WHERE id=? AND visit_id=?", (item_id, id_))
            if not r.rowcount:
                raise VisitError("Replacement not found.", 404)
        return self.get(id_)

    def complete(self, id_):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            v = self._visit(db, id_)
            if v["status"] == "DRAFT":
                if not db.execute("SELECT 1 FROM replacements WHERE visit_id=?", (id_,)).fetchone():
                    raise VisitError("Record at least one replacement before completing the visit.")
                db.execute("UPDATE visits SET status='COMPLETED',completed_at=? WHERE id=?", (now(), id_))
        return self.get(id_)


def report(visit):
    totals = {}
    for item in visit["replacements"]:
        for p in item["parts"]:
            key = (p["part_no"], p["unit"])
            totals[key] = totals.get(key, 0) + p["qty"]
    return {**visit, "totals": [{"part_no": k[0], "unit": k[1], "qty": v} for k, v in sorted(totals.items())]}
