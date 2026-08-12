import type { SupportSelectionMethod } from "../types/config.js";

export const SUPPORT_SELECTION_METHODS = [
  "mass_ratio",
  "tail_budget",
  "shannon",
  "participation_ratio",
  "largest_mass_gap",
] as const satisfies readonly SupportSelectionMethod[];

export function normalizeSupportSelectionMethod(
  value: unknown,
): SupportSelectionMethod {
  if (value === undefined) return "mass_ratio";
  if (
    typeof value === "string" &&
    (SUPPORT_SELECTION_METHODS as readonly string[]).includes(value)
  ) {
    return value as SupportSelectionMethod;
  }
  throw new TypeError(
    `Invalid supportSelectionMethod: expected one of ${SUPPORT_SELECTION_METHODS.join(", ")}`,
  );
}
