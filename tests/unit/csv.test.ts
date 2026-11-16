import { describe, expect, test } from "vitest";
import { parseCsv } from "../../src/importer/readers/csv.ts";

describe("parseCsv strictness (IMP-11)", () => {
  test.each([
    ['"x"y,z', 1],
    ['a,b\nab"c,d', 2],
    ["a,a\n1,2", 1],
    [",b\n1,2", 1],
    ["a,b\n1", 2],
  ] as const)("parseCsv(%j) throws naming line %i", (text, line) => {
    expect(() => parseCsv(text)).toThrow(new RegExp(`\\bline ${line}\\b`));
  });

  test("counts lines inside quoted fields when naming a ragged row", () => {
    expect(() => parseCsv('a,b\n"one\ntwo",x\n1')).toThrow(/\bline 4\b/);
  });

  test("a quoted field ending the input without its closing quote names the line it opened on", () => {
    expect(() => parseCsv('a,b\n1,"open\nstill open')).toThrow(/\bline 2\b/);
  });

  test("BOM, CRLF, lone CR, quoted newline, doubled quotes, no trailing newline still parse", () => {
    const table = parseCsv('﻿id,label,note\r\n007,"1-9, 14-27",\r738,"say ""hi""","two\r\nlines"\n9,,last');
    expect(table.hasBom).toBe(true);
    expect(table.headers).toEqual(["id", "label", "note"]);
    expect(table.records).toEqual([
      { id: "007", label: "1-9, 14-27", note: "" },
      { id: "738", label: 'say "hi"', note: "two\r\nlines" },
      { id: "9", label: "", note: "last" },
    ]);
  });

  test("a closing quote may be followed by a comma, a line break or the end of input", () => {
    expect(parseCsv('"a","b"\r\n"1",""').records).toEqual([{ a: "1", b: "" }]);
  });
});
