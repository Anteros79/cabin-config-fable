import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.lookup import parts_for_check
from app.repository import SQLiteRepository
from app.seed import DEFAULT_DB, ROOT
from app.visits import VisitError, VisitStore, report


class VisitInput(BaseModel):
    tail: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9-]+$")
    check_date: date
    technician: str = Field(default="", max_length=80)


class ReplacementInput(BaseModel):
    location: str = Field(min_length=1, max_length=40)
    rule_id: str = Field(min_length=1, max_length=100)
    substitute_id: str | None = Field(default=None, max_length=100)
    quantity: int = Field(default=1, ge=1, le=100, strict=True)
    note: str = Field(default="", max_length=1000)


def create_app(reference_path=None, visits_path=None):
    repo = SQLiteRepository(reference_path or Path(os.getenv("CABIN_DB_PATH", str(DEFAULT_DB))))
    store = VisitStore(visits_path or Path(os.getenv("CABIN_VISITS_DB_PATH", str(ROOT / "data/visits.sqlite3"))))

    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        yield

    app = FastAPI(title="Cabin Kit · Fictional data lab", lifespan=lifespan)

    @app.exception_handler(VisitError)
    async def visit_error(request: Request, exc: VisitError):
        return JSONResponse(status_code=exc.status, content={"detail": str(exc)})

    @app.exception_handler(sqlite3.Error)
    async def db_error(request: Request, exc: sqlite3.Error):
        return JSONResponse(status_code=503, content={"detail": "Database unavailable. Check local setup and seed the reference dataset."})

    @app.middleware("http")
    async def local_write_protection(request: Request, call_next):
        origin = request.headers.get("origin")
        if (request.method in ("POST", "PUT", "DELETE") and origin and origin != str(request.base_url).rstrip("/")):
            return JSONResponse(status_code=403, content={"detail": "Cross-origin writes are not allowed."})
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/health")
    def health():
        repo.aircraft_list()
        store.list()
        return {"status": "ok", "demo": True}

    @app.get("/api/aircraft")
    def aircraft():
        return repo.aircraft_list()

    @app.get("/api/lookup")
    def lookup(tail: str, check_date: date):
        with repo.snapshot() as reader:
            return parts_for_check(tail, check_date, reader)

    @app.get("/api/visits")
    def visits():
        return store.list()

    @app.post("/api/visits", status_code=201)
    def create_visit(body: VisitInput):
        with repo.snapshot() as reader:
            result = parts_for_check(body.tail, body.check_date, reader)
        return store.create(result, body.technician)

    @app.get("/api/visits/{visit_id}")
    def get_visit(visit_id: str):
        return store.get(visit_id)

    @app.put("/api/visits/{visit_id}/replacements")
    def add_replacement(visit_id: str, body: ReplacementInput):
        return store.add(visit_id, **body.model_dump())

    @app.delete("/api/visits/{visit_id}/replacements/{item_id}")
    def remove_replacement(visit_id: str, item_id: str):
        return store.remove(visit_id, item_id)

    @app.post("/api/visits/{visit_id}/complete")
    def complete(visit_id: str):
        return report(store.complete(visit_id))

    @app.get("/api/visits/{visit_id}/report")
    def get_report(visit_id: str):
        return report(store.get(visit_id))

    app.mount("/", StaticFiles(directory=ROOT / "app/static", html=True), name="static")
    return app


app = create_app()
