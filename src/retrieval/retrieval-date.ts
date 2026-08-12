export type RetrievalDateValue = number | string;

/** Convert a public retrieval date into the only runtime representation. */
export function parseRetrievalDate(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRetrievalDate(
  value: RetrievalDateValue | undefined,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseRetrievalDate(value);
  if (parsed === null) {
    throw new TypeError(
      `Invalid retrieval plan parameter ${path}: expected a valid date`,
    );
  }
  return parsed;
}
