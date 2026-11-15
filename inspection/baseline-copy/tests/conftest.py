import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.repository import SQLiteRepository
from app.seed import seed


@pytest.fixture
def reference(tmp_path):
    path = tmp_path / "reference.sqlite3"
    seed(path)
    return path


@pytest.fixture
def repo(reference):
    return SQLiteRepository(reference)


@pytest.fixture
def edit(reference):
    def execute(sql, args=()):
        with sqlite3.connect(reference) as db:
            db.execute(sql, args)
    return execute


@pytest.fixture
def client(reference, tmp_path):
    with TestClient(create_app(reference, tmp_path / "visits.sqlite3")) as client:
        yield client
