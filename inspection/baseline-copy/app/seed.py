"""Deterministic fictional reference data. Rebuild: python -m app.seed --reset."""
import argparse
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data/reference.sqlite3"


def demo_seats(n):
    if n == 11:
        return []
    seats = []
    rows = 23 if n in (9, 10) else 29 if n == 3 else 30
    for row in range(1, rows + 1):
        exit_row = row == 12 if n in (9, 10) else row in (14, 15)
        letters = "ACDF" if exit_row and n not in (9, 10) else "ABCDEF"
        if n == 9 and row == 23:
            letters = "ABDEF"
        for letter in letters:
            side = "L" if letter in "ABC" else "R"
            count = sum((x in "ABC") == (side == "L") for x in letters)
            seats.append({"id": f"{row}{letter}", "row": row, "letter": letter,
                "side": side, "seat_pos": letter, "exit_row": exit_row,
                "seat_group": {2: "DOUBLE", 3: "TRIPLE"}[count],
                "zone": "EXIT" if exit_row else "ELR" if row <= 5 else "STD"})
    return seats


def seed(path=DEFAULT_DB, reset=False):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if not reset:
            raise ValueError("Database exists; use --reset to rebuild fictional reference data.")
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            if db.execute("SELECT value FROM metadata WHERE key='dataset'").fetchone() != ("fictional-cabin-kit",):
                raise ValueError("Refusing to overwrite a database not owned by this seeder.")
    fd, temp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    os.close(fd)
    try:
        with closing(sqlite3.connect(temp)) as db, db:
            db.executescript((ROOT / "app/schema.sql").read_text())
            db.execute("INSERT INTO metadata VALUES ('dataset','fictional-cabin-kit')")

            def insert(table, **row):
                db.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})", tuple(row.values()))

            for id_, kind, rev, title, expires in [
                ("DOC-A", "EO", "A", "Fictional seat and bin applicability", None),
                ("DOC-B", "ENG", "-", "Fictional carpet applicability", None),
                ("DOC-C", "ENG", "B", "Fictional retrofit and seam change", None),
                ("DOC-DEV", "DEVIATION_EA", "-", "Fictional substitute kit approval", "2026-12-31"),
                ("DOC-CONFIG", "DEMO", "1", "Fictional layout and tail configuration", None),
            ]:
                insert("source_doc", id=id_, type=kind, rev=rev, title=title,
                       owner="Demo engineering desk", eff_from="2020-01-01", expires=expires)
            specs = [
                ("MAX8", "Recaro", "Post-ELR", "Final", 1, "Full", "Active"),
                ("MAX8", "Meridian", "Post-ELR", "Final", 1, "Full", "Active"),
                ("MAX8", "Meridian", "Post-ELR", "Temporary", 1, "Full", "Being retired"),
                ("800", "Recaro", "Post-ELR", "Final", 1, "Full", "Retrofit in progress"),
                ("800", "Meridian", "Post-ELR", "Final", 1, "Full", "Active"),
                ("800", "Meridian", "Post-ELR", "Final", 1, "Half", "Active"),
                ("800", "Meridian", "Post-ELR", "Final", 0, None, "Active"),
                ("800", "Innovator", "ELR", "No designators", 0, None, "Small group"),
                ("700", "Innovator", "Standard", "137 seats", 0, "n/a", "Exiting fleet"),
                ("700", "Meridian / Recaro-look covers", "Standard", "138 seats", 1, "n/a", "Retrofit in progress"),
                ("MAX7", None, None, None, None, None, "Planned"),
            ]
            for n, (fleet, maker, elr, layout, power, height, status) in enumerate(specs, 1):
                variant = f"V{n:02}"
                insert("variant", id=variant, name=f"{fleet} / {maker or 'TBD'}", subfleet=fleet,
                       seat_mfr=maker, elr=elr, layout=layout, power=power, cabin_height=height,
                       status=status, released=n != 11, seats=json.dumps(demo_seats(n)))
                tail = "N101TL" if n == 10 else f"N{n:02}0TL"
                insert("aircraft", tail=tail, subfleet=fleet, etops=n == 2)
                insert("tail_config", tail=tail, variant_id=variant,
                       carpet="BOTANY" if n in (4, 5, 6) else "MOHAWK",
                       seam="POST" if n in (4, 6, 10) else "PRE",
                       cabin_height="Half" if n == 7 else None, eff_from="2024-01-01",
                       eff_to=None, doc_id="DOC-CONFIG")
            for tail, fleet in [("N100TL", "MAX8"), ("N200TL", "800"), ("N300TL", "700"), ("N000TL", "800")]:
                insert("aircraft", tail=tail, subfleet=fleet, etops=False)
            for tail, variant, carpet, seam, start, end in [
                ("N100TL", "V01", "MOHAWK", "PRE", "2025-10-01", None),
                ("N200TL", "V05", "BOTANY", "PRE", "2024-01-01", "2026-06-30"),
                ("N200TL", "V04", "BOTANY", "POST", "2026-07-01", None),
                ("N300TL", "V10", "MOHAWK", "POST", "2026-03-15", None),
            ]:
                insert("tail_config", tail=tail, variant_id=variant, carpet=carpet, seam=seam,
                       eff_from=start, eff_to=end, doc_id="DOC-CONFIG")
            positions = []
            for component in ("CUSHION", "BACKREST"):
                for zone in ("ELR", "STD", "EXIT"):
                    for letter in "ABCDEF":
                        id_ = f"P-{zone}-{letter}-{component}"
                        positions.append(id_)
                        insert("position", id=id_, label=f"{zone} · {letter} · {component.title()} cover",
                               category="SEAT", zone=zone, component=component, row_from=1, row_to=30,
                               side="L" if letter in "ABC" else "R", seat_pos=letter, exit_row=zone == "EXIT")
            for id_, label, location, component in [
                ("P-CARPET-KIT", "Full cabin carpet kit", "FULL_CABIN", "CARPET_KIT"),
                ("P-FORWARD-PANEL", "Forward carpet panel", "FORWARD", "CARPET_PANEL"),
            ]:
                positions.append(id_)
                insert("position", id=id_, label=label, category="CARPET", zone="FLOOR",
                       component=component, panel_loc=location)
            for side in ("L", "R"):
                for module in range(1, 11):
                    location = f"BIN-{side}-{module:02}"
                    id_ = f"P-{location}"
                    positions.append(id_)
                    insert("position", id=id_, label=f"Overhead bin {side}{module:02} door",
                           category="BIN", zone="OVERHEAD", component="BIN_DOOR", side=side,
                           row_from=(module-1)*3+1, row_to=module*3, panel_loc=location)
            for n in range(1, 11):
                for pos in positions:
                    if "BIN" in pos and int(pos[-2:]) > (max(s['row'] for s in demo_seats(n))+2)//3:
                        continue
                    insert("variant_position", variant_id=f"V{n:02}", position_id=pos)
                    carpet = "CARPET" in pos or "PANEL" in pos
                    part = f"FAKE-V{n:02}-{pos[2:]}"
                    if n == 1:
                        part = {"P-ELR-A-CUSHION": "FAKE-SC-1001", "P-STD-A-CUSHION": "FAKE-SC-1002", "P-CARPET-KIT": "FAKE-CK-2001"}.get(pos, part)
                    insert("part_rule", id=f"R-V{n:02}-{pos}", position_id=pos,
                           selectors=json.dumps({"variant_id": f"V{n:02}"}), part_no=part,
                           qty=1, unit="KIT" if pos == "P-CARPET-KIT" else "PANEL" if carpet else "EA",
                           eff_from="2024-01-01", doc_id="DOC-B" if carpet else "DOC-A")
            insert("part_rule", id="R4", position_id="P-CARPET-KIT",
                   selectors=json.dumps({"variant_id": "V04", "carpet": "BOTANY", "seam": "POST"}),
                   part_no="FAKE-CK-2002", qty=1, unit="KIT", eff_from="2026-07-01",
                   pending_change=1, change_note="Fictional STA 521 revision pending.", doc_id="DOC-C")
            insert("substitute", id="SUB-KIT-1", rule_id="R-V01-P-CARPET-KIT",
                   alt_part_no="FAKE-CK-2000", qty=1, unit="KIT", eff_from="2025-07-22", doc_id="DOC-DEV")
            for panel, qty in [(39, 2), (40, 2), (41, 1), (42, 1)]:
                insert("substitute_panel", substitute_id="SUB-KIT-1", part_no=f"FAKE-P-{panel}", qty=qty)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    seed(args.db, args.reset)
    print(f"Fictional reference data ready: {args.db}. Visit history was not changed.")
