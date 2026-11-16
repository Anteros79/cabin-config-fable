import { describe, expect, test } from "vitest";
import { parseCliArgs, UsageError } from "../../src/importer/args.ts";

const SPEC = { "data-dir": { type: "string" }, label: { type: "string" }, yes: { type: "boolean" } } as const;

describe("parseCliArgs", () => {
  test.each([
    [["--no-activte"], /Unknown option/],
    [["--data-dir"], /--data-dir needs a value/],
    [["--data-dir", "--yes"], /--data-dir needs a value/],
    [["--data-dir="], /--data-dir needs a value/],
    [["--data-dir", ""], /--data-dir needs a value/],
    [["--yes=1"], /--yes/],
    [["stray"], /Unexpected argument/],
  ])("parseCliArgs(%j) throws UsageError", (argv, re) => {
    expect(() => parseCliArgs(argv, SPEC)).toThrow(UsageError);
    expect(() => parseCliArgs(argv, SPEC)).toThrow(re);
  });

  test("--name=value and --name value are equivalent", () => {
    expect(parseCliArgs(["--data-dir=/a b", "--yes"], SPEC)).toEqual({ "data-dir": "/a b", yes: true });
    expect(parseCliArgs(["--data-dir", "/a b", "--yes"], SPEC)).toEqual({ "data-dir": "/a b", yes: true });
  });

  test("options that are absent stay undefined", () => {
    expect(parseCliArgs([], SPEC)).toEqual({});
  });
});
