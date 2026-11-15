import json
from datetime import date

import pytest

from app.lookup import parts_for_check


def lookup(repo, tail="N100TL", day="2026-11-12"):
    return parts_for_check(tail, date.fromisoformat(day), repo)


@pytest.mark.parametrize("n", range(1, 12))
def test_each_variant(repo, n):
    r = lookup(repo, "N101TL" if n == 10 else f"N{n:02}0TL")
    if n == 11:
        assert r["status"] == "NO_CONFIG" and r["lines"] == []
    else:
        assert r["status"] == "OK"
        assert r["configuration"]["variant_id"] == f"V{n:02}"
        assert {line["position"]["category"] for line in r["lines"]} == {"SEAT", "CARPET", "BIN"}


@pytest.mark.parametrize("day,variant", [("2026-06-30", "V05"), ("2026-07-01", "V04")])
def test_retrofit_boundary(repo, day, variant):
    assert lookup(repo, "N200TL", day)["configuration"]["variant_id"] == variant


@pytest.mark.parametrize("tail,day,status", [
    ("N000TL", "2026-11-12", "NO_CONFIG"), ("N100TL", "2025-09-30", "NO_CONFIG"),
    ("UNKNOWN", "2026-11-12", "UNKNOWN_TAIL"), ("N110TL", "2026-11-12", "NO_CONFIG"),
])
def test_missing_configuration(repo, tail, day, status):
    r = lookup(repo, tail, day)
    assert r["status"] == status and r["lines"] == []


@pytest.mark.parametrize("day,count", [("2026-12-31", 1), ("2027-01-01", 0)])
def test_substitute_expiration(repo, day, count):
    line = next(r for r in lookup(repo, day=day)["lines"] if r["part_no"] == "FAKE-CK-2001")
    assert len(line["substitutes"]) == count
    if count:
        assert sum(p["qty"] for p in line["substitutes"][0]["with_panels"]) == 6


def test_botany_seam_specificity(repo):
    line = next(r for r in lookup(repo, "N200TL")["lines"] if r["position_id"] == "P-CARPET-KIT")
    assert line["part_no"] == "FAKE-CK-2002" and line["pending_change"]


def test_overlapping_configurations(repo, edit):
    edit("INSERT INTO tail_config(tail,variant_id,eff_from,doc_id) VALUES('N100TL','V02','2026-01-01','DOC-CONFIG')")
    r = lookup(repo)
    assert r["status"] == "AMBIGUOUS_CONFIG" and r["lines"] == []


def test_expired_rule_leaves_gap(repo, edit):
    edit("UPDATE part_rule SET eff_to='2026-11-11' WHERE part_no='FAKE-SC-1001'")
    r = lookup(repo)
    assert r["status"] == "PARTIAL"
    assert not any(l["part_no"] == "FAKE-SC-1001" for l in r["lines"])
    assert any(i["position"]["id"] == "P-ELR-A-CUSHION" for i in r["issues"])


def test_expired_source_removes_parts(repo, edit):
    edit("UPDATE source_doc SET expires='2026-11-11' WHERE id='DOC-A'")
    assert not any(r["source"]["id"] == "DOC-A" for r in lookup(repo)["lines"])


def test_expired_configuration_source(repo, edit):
    edit("UPDATE source_doc SET expires='2026-11-11' WHERE id='DOC-CONFIG'")
    assert lookup(repo)["status"] == "NO_CONFIG"


def extra_rule(edit, selectors):
    edit("INSERT INTO part_rule(id,position_id,selectors,part_no,qty,unit,eff_from,doc_id) VALUES('OTHER','P-ELR-A-CUSHION',?,'FAKE-OTHER',1,'EA','2024-01-01','DOC-A')", (json.dumps(selectors),))


def test_variant_dominates_fleet(repo, edit):
    extra_rule(edit, {"subfleet": "MAX8"})
    r = lookup(repo)
    assert r["status"] == "OK"
    assert any(l["part_no"] == "FAKE-SC-1001" for l in r["lines"])


@pytest.mark.parametrize("selectors", [{"variant_id": "V01"}, {"carpet": "MOHAWK"}])
def test_conflicting_rules_are_refused(repo, edit, selectors):
    extra_rule(edit, selectors)
    r = lookup(repo)
    assert r["status"] == "PARTIAL"
    assert any(i["code"] == "AMBIGUOUS_RULE" for i in r["issues"])
    assert not any(l["position_id"] == "P-ELR-A-CUSHION" for l in r["lines"])


def test_wrong_carpet_does_not_match(repo, edit):
    extra_rule(edit, {"variant_id": "V01", "carpet": "BOTANY"})
    assert not any(r["id"] == "OTHER" for r in lookup(repo)["lines"])


def test_no_rules(repo, edit):
    edit("DELETE FROM part_rule")
    r = lookup(repo)
    assert r["status"] == "NO_RULES" and r["issues"]


def test_700_exact_layouts(repo):
    a = lookup(repo, "N090TL")["configuration"]["variant"]["seats"]
    b = lookup(repo, "N300TL")["configuration"]["variant"]["seats"]
    assert len(a) == 137 and len(b) == 138
    assert "23C" not in {s["id"] for s in a}
    assert "23C" in {s["id"] for s in b}


def test_normalized_tail(repo):
    assert lookup(repo, " n100tl ")["status"] == "OK"
