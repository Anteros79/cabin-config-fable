import { expect, test } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.ts";
import { sha256Hex } from "../../src/domain/hash.ts";
import { byKey, compareCodePoints } from "../../src/domain/order.ts";

test("order is independent of the host locale", () => {
  expect(["FAKE-AZ-1", "FAKE-AA-1", "A_B", "AB"].sort(compareCodePoints)).toEqual(["AB", "A_B", "FAKE-AA-1", "FAKE-AZ-1"]);
});

test("compareCodePoints returns -1, 0 or 1 and orders upper case before lower case", () => {
  expect(compareCodePoints("a", "b")).toBe(-1);
  expect(compareCodePoints("b", "a")).toBe(1);
  expect(compareCodePoints("a", "a")).toBe(0);
  expect(compareCodePoints("Z", "a")).toBe(-1);
});

test("byKey sorts by the extracted key", () => {
  const items = [{ id: "b" }, { id: "a" }, { id: "C" }];
  expect(items.sort(byKey((item) => item.id)).map((item) => item.id)).toEqual(["C", "a", "b"]);
});

test("canonicalJson sorts keys at every depth and is stable", () => {
  expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test("canonicalJson refuses non-finite numbers", () => {
  expect(() => canonicalJson({ q: Infinity })).toThrow(/non-finite/);
  expect(() => canonicalJson({ q: NaN })).toThrow(/non-finite/);
  expect(() => canonicalJson({ a: [1, -Infinity] })).toThrow(/non-finite number at a\[1\]/);
});

test("sha256Hex matches the known digest of the empty string", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
