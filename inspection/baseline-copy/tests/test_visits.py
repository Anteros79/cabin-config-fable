import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import seed
from app.visits import VisitError, VisitStore


def create(client, day="2026-11-12"):
    r = client.post("/api/visits", json={"tail": "N100TL", "check_date": day, "technician": "Demo Tech"})
    assert r.status_code == 201
    return r.json()


def add(client, visit, **updates):
    return client.put(f"/api/visits/{visit['id']}/replacements", json={"location": "3A", "rule_id": "R-V01-P-ELR-A-CUSHION", "quantity": 1, "note": "Fictional scuff"} | updates)


def test_complete_report_is_immutable(client, edit):
    v = create(client)
    assert add(client, v).status_code == 200
    assert len(add(client, v).json()["replacements"]) == 1
    r = add(client, v, location="FULL_CABIN", rule_id="R-V01-P-CARPET-KIT", substitute_id="SUB-KIT-1")
    assert r.status_code == 200 and len(r.json()["replacements"][1]["parts"]) == 5
    r = client.post(f"/api/visits/{v['id']}/complete").json()
    assert r["status"] == "COMPLETED" and len(r["totals"]) == 6
    assert sum(p["qty"] for p in r["totals"]) == 8
    assert add(client, v).status_code == 409
    item = r["replacements"][0]
    assert client.delete(f"/api/visits/{v['id']}/replacements/{item['id']}").status_code == 409
    edit("UPDATE source_doc SET rev='CHANGED' WHERE id='DOC-A'")
    edit("UPDATE part_rule SET part_no='FAKE-CHANGED' WHERE part_no='FAKE-SC-1001'")
    saved = client.get(f"/api/visits/{v['id']}/report").json()
    assert saved["replacements"][0]["source"]["rev"] == "A"
    assert saved["replacements"][0]["parts"][0]["part_no"] == "FAKE-SC-1001"
    assert client.post(f"/api/visits/{v['id']}/complete").json()["completed_at"] == r["completed_at"]


def test_substitute_replaces_primary(client):
    v = create(client)
    add(client, v, location="FULL_CABIN", rule_id="R-V01-P-CARPET-KIT")
    r = add(client, v, location="FULL_CABIN", rule_id="R-V01-P-CARPET-KIT", substitute_id="SUB-KIT-1").json()
    assert len(r["replacements"]) == 1
    assert r["replacements"][0]["parts"][0]["part_no"] == "FAKE-CK-2000"


@pytest.mark.parametrize("updates", [
    {"location": "99Z"}, {"location": "3B"}, {"quantity": 2}, {"quantity": 0},
    {"quantity": 1.5}, {"quantity": True}, {"quantity": 101}, {"rule_id": "nonexistent"},
    {"substitute_id": "not-approved"}, {"location": "14B", "rule_id": "R-V01-P-EXIT-B-CUSHION"},
    {"location": "BIN-L-99", "rule_id": "R-V01-P-BIN-L-01"},
])
def test_invalid_replacements(client, updates):
    assert add(client, create(client), **updates).status_code == 422


def test_expired_substitute_rejected(client):
    assert add(client, create(client, "2027-01-01"), location="FULL_CABIN", rule_id="R-V01-P-CARPET-KIT", substitute_id="SUB-KIT-1").status_code == 422


def test_bin_door(client):
    r = add(client, create(client), location="BIN-L-01", rule_id="R-V01-P-BIN-L-01")
    assert r.status_code == 200 and r.json()["replacements"][0]["component"] == "BIN_DOOR"


def test_no_config_cannot_start(client):
    assert client.post("/api/visits", json={"tail": "N000TL", "check_date": "2026-11-12"}).status_code == 422


def test_remove_and_empty_completion(client):
    v = create(client)
    assert client.post(f"/api/visits/{v['id']}/complete").status_code == 409
    item = add(client, v).json()["replacements"][0]
    r = client.delete(f"/api/visits/{v['id']}/replacements/{item['id']}")
    assert r.status_code == 200 and r.json()["replacements"] == []


def test_restart_and_reseed_preserve_history(reference, tmp_path):
    path = tmp_path / "history.sqlite3"
    with TestClient(create_app(reference, path)) as c:
        v = create(c)
        add(c, v)
    seed(reference, reset=True)
    with TestClient(create_app(reference, path)) as c:
        assert len(c.get(f"/api/visits/{v['id']}").json()["replacements"]) == 1


def test_seed_cannot_overwrite_visits(tmp_path):
    path = tmp_path / "history.sqlite3"
    store = VisitStore(path)
    store.initialize()
    with pytest.raises(sqlite3.OperationalError, match="no such table: metadata"):
        seed(path, reset=True)
    assert store.list() == []


def test_concurrent_completion_and_edit(client, tmp_path):
    v = create(client)
    add(client, v)
    store = VisitStore(tmp_path / "visits.sqlite3")
    def edit():
        try:
            return store.add(v["id"], "3B", "R-V01-P-ELR-B-CUSHION", None, 1, "")
        except VisitError:
            return None
    with ThreadPoolExecutor(2) as pool:
        tasks = [pool.submit(store.complete, v["id"]), pool.submit(edit)]
        for task in tasks:
            task.result()
    assert store.get(v["id"])["status"] == "COMPLETED"
    with pytest.raises(VisitError):
        store.add(v["id"], "3C", "R-V01-P-ELR-C-CUSHION", None, 1, "")


def test_validation_and_origins(client):
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/lookup?tail=N100TL&check_date=bad").status_code == 422
    assert client.get("/api/visits/missing").status_code == 404
    assert client.post("/api/visits", json={"tail": "N100TL", "check_date": "2026-11-12"}, headers={"Origin": "https://unrelated.example"}).status_code == 403
