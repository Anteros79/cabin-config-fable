"""Summarise baseline API responses for the live-probe transcript.

Usage: python summarize.py <mode> <response-file> [position_id ...]
Modes: raw | lookup | visit | report | list | field:<name>
"""

from __future__ import annotations

import json
import sys


def applies(p: dict, s: dict) -> bool:
    """Mirror of baseline app/visits.py:applies (used only to count reachability)."""
    return (
        p["category"] == "SEAT"
        and p["zone"] == s["zone"]
        and p["row_from"] <= s["row"] <= p["row_to"]
        and p["side"] == s["side"]
        and p["seat_pos"] in (s["letter"], "ALL")
        and bool(p["exit_row"]) == bool(s["exit_row"])
        and (not p["seat_group"] or p["seat_group"] == s["seat_group"])
    )


def doc(d: dict | None) -> str:
    if not d:
        return "none"
    return f"{d['id']} type={d['type']} rev={d['rev']} eff_from={d['eff_from']} expires={d['expires']}"


def lookup(d: dict, wanted: list[str]) -> None:
    print(f"  status={d.get('status')} message={d.get('message')!r}")
    print(f"  tail={d.get('tail')!r} check_date={d.get('check_date')} demo={d.get('demo')}")
    cfg = d.get("configuration")
    lines, issues = d.get("lines", []), d.get("issues", [])
    if cfg:
        v, seats = cfg["variant"], cfg["variant"]["seats"]
        print(
            f"  variant={cfg['variant_id']} name={v['name']!r} subfleet={v['subfleet']} "
            f"released={v['released']} carpet={cfg['carpet']} seam={cfg['seam']} "
            f"config eff_from={cfg['eff_from']} eff_to={cfg['eff_to']}"
        )
        print(f"  config source: {doc(cfg.get('source'))}")
        if seats:
            rows = max(s["row"] for s in seats)
            ids = {s["id"] for s in seats}
            missing = [f"{r}{c}" for r in range(1, rows + 1) for c in "ABCDEF" if f"{r}{c}" not in ids]
            zones: dict[str, int] = {}
            for s in seats:
                zones[s["zone"]] = zones.get(s["zone"], 0) + 1
            exits = sorted({s["row"] for s in seats if s["exit_row"]})
            print(f"  seats={len(seats)} rows=1..{rows} exit_rows={exits} zones={zones}")
            print(f"  seats omitted from a full 6-abreast grid: {missing or 'none'}")
            seat_lines = [ln for ln in lines if ln["position"]["category"] == "SEAT"]
            dead = [ln["position"]["id"] for ln in seat_lines if not any(applies(ln["position"], s) for s in seats)]
            print(f"  seat lines that match no seat in this layout: {len(dead)} {dead}")
        else:
            print("  seats=0")
    cats: dict[str, int] = {}
    for ln in lines:
        cats[ln["position"]["category"]] = cats.get(ln["position"]["category"], 0) + 1
    print(f"  lines={len(lines)} by_category={cats} issues={len(issues)}")
    for issue in issues[:5]:
        print(f"  issue: {issue['code']} {issue['position']['id']} {issue['message']!r}")
    for pid in wanted:
        ln = next((x for x in lines if x["position"]["id"] == pid), None)
        if not ln:
            print(f"  line {pid}: <absent>")
            continue
        print(
            f"  line {pid}: rule={ln['id']} part_no={ln['part_no']} qty={ln['qty']} unit={ln['unit']} "
            f"eff_from={ln['eff_from']} eff_to={ln['eff_to']} pending_change={ln['pending_change']} "
            f"change_note={ln['change_note']!r} selectors={ln['selectors']}"
        )
        print(f"    source: {doc(ln['source'])}")
        print(f"    substitutes={len(ln['substitutes'])}")
        for sub in ln["substitutes"]:
            panels = ", ".join(f"{p['part_no']} x{p['qty']}" for p in sub["with_panels"])
            print(
                f"    substitute {sub['id']}: alt_part_no={sub['alt_part_no']} qty={sub['qty']} unit={sub['unit']} "
                f"eff_from={sub['eff_from']} eff_to={sub['eff_to']} panels=[{panels}]"
            )
            print(f"      source: {doc(sub['source'])}")


def visit(d: dict) -> None:
    if "detail" in d and "id" not in d:
        print(f"  detail={d['detail']!r}")
        return
    snap = d.get("snapshot", {})
    print(
        f"  visit id={d['id']} status={d['status']} tail={d['tail']} check_date={d['check_date']} "
        f"technician={d['technician']!r}"
    )
    print(f"  created_at={d['created_at']} completed_at={d['completed_at']}")
    print(f"  top-level keys={sorted(k for k in d if k != 'snapshot')} + snapshot")
    print(
        f"  snapshot keys={sorted(snap)} snapshot_bytes={len(json.dumps(snap))} "
        f"snapshot lines={len(snap.get('lines', []))} "
        f"snapshot seats={len(snap.get('configuration', {}).get('variant', {}).get('seats', []))}"
    )
    print(f"  replacements={len(d['replacements'])}")
    for r in d["replacements"]:
        parts = ", ".join(f"{p['part_no']} x{p['qty']} {p['unit']}" for p in r["parts"])
        print(
            f"    item id={r['id']} location={r['location']} component={r['component']} quantity={r['quantity']} "
            f"rule_id={r['rule_id']} substitute_id={r['substitute_id']} note={r['note']!r}"
        )
        print(f"      parts=[{parts}]")
        print(
            f"      source={r['source']['id']} rev={r['source']['rev']} expires={r['source']['expires']} "
            f"primary_source={r['primary_source']['id']} pending_change={r['pending_change']} "
            f"recorded_at={r['recorded_at']} keys={sorted(r)}"
        )


def main() -> None:
    mode, path, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    text = open(path, encoding="utf-8").read()
    try:
        d = json.loads(text)
    except ValueError:
        print(f"  body (non-JSON, {len(text)} bytes): {text[:200]!r}")
        return
    if mode.startswith("field:"):
        print(d[mode.split(":", 1)[1]])
    elif mode == "raw":
        out = json.dumps(d)
        print(f"  body: {out[:700]}{' …' if len(out) > 700 else ''}")
    elif mode == "lookup":
        lookup(d, rest)
    elif mode == "visit":
        visit(d)
    elif mode == "report":
        visit(d)
        print("  totals:")
        for t in d.get("totals", []):
            print(f"    TOTAL {t['part_no']} qty={t['qty']} unit={t['unit']}")
        print(f"  totals_lines={len(d.get('totals', []))} totals_qty_sum={sum(t['qty'] for t in d.get('totals', []))}")
    elif mode == "list":
        print(f"  rows={len(d)}")
        for row in d[:12]:
            print(f"    {row}")


if __name__ == "__main__":
    main()
