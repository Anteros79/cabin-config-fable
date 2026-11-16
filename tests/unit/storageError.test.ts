import { describe, expect, test } from "vitest";
import { isCorruption } from "../../src/server/storageError.ts";

const sqliteError = (errcode: number) => Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode });

describe("isCorruption", () => {
  test.each([11, 26, 267, 523, 779])("SQLite errcode %i is corruption", (code) => expect(isCorruption(sqliteError(code))).toBe(true));
  test.each([5, 8, 14, 1])("SQLite errcode %i is not", (code) => expect(isCorruption(sqliteError(code))).toBe(false));
  test("a non-SQLite error is not", () => expect(isCorruption(Object.assign(new Error("x"), { errcode: 11 }))).toBe(false));
});
