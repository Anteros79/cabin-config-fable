import { z } from "zod";
import { MAX_LIST_OFFSET } from "../../domain/limits.ts";
import { DomainError } from "../../domain/visitLogic.ts";

export const ListVisitsQuery = z
  .object({
    status: z.enum(["DRAFT", "COMPLETED"]).optional(),
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(MAX_LIST_OFFSET).default(0),
  })
  .strict();

export const LookupQuery = z
  .object({
    tail: z.string().max(40).optional(),
    date: z.string().max(40).optional(),
    format: z.enum(["csv"]).optional(),
  })
  .strict();

export const VisitIdParam = z.string().uuid();

/** Parses `value` or throws a 400 DomainError carrying the first issue as "path: message" and all issues in details. */
export function parseOr400<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const where = first?.path.join(".") ?? "";
  throw new DomainError(code, `${where}: ${first?.message ?? "Invalid value."}`, 400, { issues: parsed.error.issues });
}
