"""Dump exact fixture facts from a reference database produced by the baseline COPY's seeder.

Usage: python fixture_facts.py <reference.sqlite3>   (opened read-only)
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

db = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row


def applies(p: sqlite3.Row, s: dict) -> bool:
    return (
        p["category"] == "SEAT"
        and p["zone"] == s["zone"]
        and p["row_from"] <= s["row"] <= p["row_to"]
        and p["side"] == s["side"]
        and p["seat_pos"] in (s["letter"], "ALL")
        and bool(p["exit_row"]) == bool(s["exit_row"])
        and (not p["seat_group"] or p["seat_group"] == s["seat_group"])
    )


print("== table row counts ==")
for t in ("metadata", "aircraft", "variant", "source_doc", "tail_config", "position", "variant_position", "part_rule", "substitute", "substitute_panel"):
    print(f"{t}: {db.execute(f'SELECT count(*) FROM {t}').fetchone()[0]}")

print("\n== source documents ==")
for r in db.execute("SELECT * FROM source_doc ORDER BY id"):
    print(dict(r))

print("\n== variants: seat sets ==")
total_dead = 0
for v in db.execute("SELECT * FROM variant ORDER BY id"):
    seats = json.loads(v["seats"])
    line = (
        f"{v['id']} subfleet={v['subfleet']} seat_mfr={v['seat_mfr']} elr={v['elr']} layout={v['layout']} "
        f"power={v['power']} cabin_height={v['cabin_height']} status={v['status']!r} released={v['released']}"
    )
    print(line)
    if not seats:
        print("   seats=0 (no layout)")
        continue
    rows = max(s["row"] for s in seats)
    ids = {s["id"] for s in seats}
    omitted = [f"{r}{c}" for r in range(1, rows + 1) for c in "ABCDEF" if f"{r}{c}" not in ids]
    zones: dict[str, int] = {}
    groups: dict[str, int] = {}
    for s in seats:
        zones[s["zone"]] = zones.get(s["zone"], 0) + 1
        groups[s["seat_group"]] = groups.get(s["seat_group"], 0) + 1
    exits = sorted({s["row"] for s in seats if s["exit_row"]})
    exit_letters = sorted({s["letter"] for s in seats if s["exit_row"]})
    positions = db.execute(
        "SELECT p.* FROM position p JOIN variant_position vp ON vp.position_id=p.id WHERE vp.variant_id=?", (v["id"],)
    ).fetchall()
    cats: dict[str, int] = {}
    for p in positions:
        cats[p["category"]] = cats.get(p["category"], 0) + 1
    dead = sorted(p["id"] for p in positions if p["category"] == "SEAT" and not any(applies(p, s) for s in seats))
    total_dead += len(dead)
    rules = db.execute("SELECT count(*) FROM part_rule WHERE selectors LIKE ?", (f'%"{v["id"]}"%',)).fetchone()[0]
    uncovered = [s["id"] for s in seats if sum(applies(p, s) for p in positions) != 2]
    print(f"   seats={len(seats)} rows=1..{rows} exit_rows={exits} exit_letters={''.join(exit_letters)} omitted={omitted or 'none'}")
    print(f"   zones={zones} seat_groups={groups} last_row_ids={sorted(s['id'] for s in seats if s['row'] == rows)}")
    print(f"   positions={len(positions)} {cats} rules_selecting_variant={rules}")
    print(f"   seat positions no seat can match ({len(dead)}): {dead}")
    print(f"   seats not covered by exactly one CUSHION + one BACKREST position: {uncovered or 'none'}")
print(f"total unreachable seat-position rules across variants: {total_dead}")

print("\n== aircraft and dated tail configurations ==")
for r in db.execute(
    "SELECT a.tail,a.subfleet,a.etops,c.variant_id,c.carpet,c.seam,c.cabin_height,c.eff_from,c.eff_to,c.doc_id "
    "FROM aircraft a LEFT JOIN tail_config c ON c.tail=a.tail ORDER BY a.tail,c.eff_from"
):
    print(dict(r))

print("\n== positions: shape of the seat/bin/carpet patterns ==")
for r in db.execute(
    "SELECT category,zone,component,count(*) n,min(row_from) rf,max(row_to) rt,group_concat(DISTINCT seat_pos) pos,"
    "group_concat(DISTINCT exit_row) ex,group_concat(DISTINCT coalesce(seat_group,'NULL')) grp FROM position "
    "GROUP BY category,zone,component ORDER BY category,zone,component"
):
    print(dict(r))
for r in db.execute("SELECT id,row_from,row_to,panel_loc FROM position WHERE category!='SEAT' AND (id LIKE 'P-BIN-L-0%' OR category='CARPET') ORDER BY id"):
    print(dict(r))

print("\n== named (non-generated) part rules ==")
for r in db.execute("SELECT * FROM part_rule WHERE part_no NOT LIKE 'FAKE-V%' ORDER BY id"):
    print(dict(r))
print("selector shapes:", [dict(r) for r in db.execute("SELECT selectors,count(*) n FROM part_rule GROUP BY selectors ORDER BY n DESC LIMIT 3")], "…")
print("rule eff_from values:", [dict(r) for r in db.execute("SELECT eff_from,eff_to,count(*) n FROM part_rule GROUP BY eff_from,eff_to")])
print("rule docs:", [dict(r) for r in db.execute("SELECT doc_id,count(*) n FROM part_rule GROUP BY doc_id")])
print("units:", [dict(r) for r in db.execute("SELECT unit,count(*) n FROM part_rule GROUP BY unit")])

print("\n== substitutes and mandatory panels ==")
for r in db.execute("SELECT * FROM substitute"):
    print(dict(r))
for r in db.execute("SELECT * FROM substitute_panel ORDER BY part_no"):
    print(dict(r))

print("\n== schema guards present ==")
for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL"):
    print(dict(r))
print("triggers:", db.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0])
print("foreign_keys pragma on a fresh read connection:", db.execute("PRAGMA foreign_keys").fetchone()[0])
