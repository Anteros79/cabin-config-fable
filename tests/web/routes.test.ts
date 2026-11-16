import { describe, expect, it } from "vitest";
import { formatRoute, isInPageAnchor, parseRoute, type Route } from "../../src/web/routes.ts";

const ID = "3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b";
const sampleRoutes: Route[] = [
  { name: "check", tail: null, date: null },
  { name: "check", tail: "N100TL", date: "2026-11-12" },
  { name: "check", tail: "N100TL", date: null },
  { name: "visit", id: ID },
  { name: "report", id: ID },
  { name: "prep", visitId: ID, tail: null, date: null },
  { name: "prep", visitId: null, tail: "N100TL", date: "2026-11-12" },
  { name: "prep", visitId: null, tail: null, date: null },
  { name: "visits", status: null, q: "", page: 1 },
  { name: "visits", status: "DRAFT", q: "N100", page: 3 },
  { name: "visits", status: "COMPLETED", q: "", page: 2 },
  { name: "layouts", id: null },
  { name: "layouts", id: "LAYOUT-A/rev 2" },
  { name: "reference" },
];

describe("parseRoute", () => {
  it.each(["#/visit/%E0%A4%A", "#/visit/not-a-uuid", "#/nope", "#/visit/", "#main", `#/visit/${ID}/other`, "#/visits/extra"])(
    "parseRoute(%j) is notFound and does not throw",
    (hash) => {
      expect(parseRoute(hash)).toEqual({ name: "notFound", hash });
    },
  );

  it.each(["", "#", "#/", "#/check"])("parseRoute(%j) is the check route", (hash) => {
    expect(parseRoute(hash)).toEqual({ name: "check", tail: null, date: null });
  });

  it("reads the lookup from the query", () => {
    expect(parseRoute("#/check?tail=N100TL&date=2026-11-12")).toEqual({ name: "check", tail: "N100TL", date: "2026-11-12" });
  });

  it("falls back for a bad status or page", () => {
    expect(parseRoute("#/visits?status=NOPE&page=-4")).toEqual({ name: "visits", status: null, q: "", page: 1 });
    expect(parseRoute("#/visits?page=abc")).toEqual({ name: "visits", status: null, q: "", page: 1 });
  });
});

describe("formatRoute", () => {
  it("writes the documented shapes", () => {
    expect(formatRoute({ name: "visit", id: ID })).toBe(`#/visit/${ID}`);
    expect(formatRoute({ name: "check", tail: "N100TL", date: "2026-11-12" })).toBe("#/check?tail=N100TL&date=2026-11-12");
    expect(formatRoute({ name: "check", tail: null, date: null })).toBe("#/check");
  });

  it("format and parse round-trip", () => {
    for (const r of sampleRoutes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });

  it("tail and date with unusual characters survive the round trip", () => {
    const r: Route = { name: "check", tail: "N 1&0=0/T?L#é+", date: "2026-11-12 &x" };
    expect(parseRoute(formatRoute(r))).toEqual(r);
    const v: Route = { name: "visits", status: null, q: "tech & co=1 100%?", page: 2 };
    expect(parseRoute(formatRoute(v))).toEqual(v);
  });
});

describe("isInPageAnchor", () => {
  it.each([
    ["#main", true],
    ["#inspector-heading", true],
    ["#/visits", false],
    ["#/", false],
    ["#", false],
    ["", false],
  ])("isInPageAnchor(%j) = %j", (hash, expected) => {
    expect(isInPageAnchor(hash)).toBe(expected);
  });
});
