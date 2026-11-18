import type { Condition } from "./types.ts";

/** A problem's condition in words; the code stays in the data. */
const CONDITION_LABEL: Record<Condition, string> = {
  STAINED: "Stained",
  TORN: "Torn",
  WORN: "Worn",
  BROKEN: "Broken",
  MISSING: "Missing",
  WONT_LATCH: "Won't latch",
  OTHER: "Other",
};
export const conditionLabel = (c: Condition): string => CONDITION_LABEL[c];
