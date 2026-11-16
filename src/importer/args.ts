import { parseArgs } from "node:util";

export interface OptionSpec {
  type: "string" | "boolean";
}

/** The command line cannot be used as typed. The CLI prints the message and the usage text, then exits 64. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Parsed<S extends Record<string, OptionSpec>> = { [K in keyof S]?: S[K]["type"] extends "string" ? string : boolean };

/**
 * Strict option parsing: unknown options, positional arguments, a value on a boolean option and a
 * string option with no value (missing, empty, or followed by another `--option`) all throw UsageError.
 * `--name value` and `--name=value` are equivalent.
 */
export function parseCliArgs<S extends Record<string, OptionSpec>>(argv: string[], spec: S): Parsed<S> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, options: spec, strict: true, allowPositionals: false }).values;
  } catch (e) {
    const message = (e as Error).message;
    // "Option '--data-dir <value>' argument missing" / "... argument is ambiguous": a string option without a value.
    if ((e as { code?: string }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const name = /'--([^\s'=]+)/.exec(message)?.[1];
      if (name && spec[name]?.type === "string") throw new UsageError(`--${name} needs a value`);
    }
    throw new UsageError(message);
  }
  for (const [name, value] of Object.entries(values)) {
    if (spec[name]?.type === "string" && (value === "" || (typeof value === "string" && value.startsWith("--")))) {
      throw new UsageError(`--${name} needs a value`);
    }
  }
  return values as Parsed<S>;
}
