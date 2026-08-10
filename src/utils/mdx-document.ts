import { parse as parseYaml } from "yaml";

export type MdxFrontmatter = Record<string, unknown>;

export interface MdxDocument {
  body: string;
  frontmatter: MdxFrontmatter;
  hasFrontmatter: boolean;
}

const FRONT_MATTER_START = /^---[ \t]*(?:\r?\n|$)/;
const FRONT_MATTER_END = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;

function isJsonCompatible(value: unknown, seen: Set<unknown>): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return false;
    case "object":
      break;
  }

  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((item) => isJsonCompatible(item, seen));
  }

  return Object.entries(value).every(
    ([key, item]) => typeof key === "string" && isJsonCompatible(item, seen),
  );
}

/**
 * Parse an optional YAML front matter block from an MD/MDX document.
 *
 * The parser intentionally does not evaluate MDX. Everything after the
 * front matter delimiter is returned as plain text for chunking/embedding.
 */
export function parseMdxDocument(content: string): MdxDocument {
  const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const start = FRONT_MATTER_START.exec(withoutBom);

  if (!start) {
    return {
      body: content,
      frontmatter: {},
      hasFrontmatter: false,
    };
  }

  FRONT_MATTER_END.lastIndex = start[0].length;
  const end = FRONT_MATTER_END.exec(withoutBom);
  FRONT_MATTER_END.lastIndex = 0;

  if (!end || end.index < start[0].length) {
    throw new Error("MDX front matter is missing a closing delimiter.");
  }

  const yamlText = withoutBom.slice(start[0].length, end.index);
  const parsed = parseYaml(yamlText) as unknown;
  const frontmatter = parsed === null ? {} : parsed;

  if (
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter) ||
    !isJsonCompatible(frontmatter, new Set())
  ) {
    throw new Error("MDX front matter must be a JSON-compatible object.");
  }

  let body = withoutBom.slice(end.index + end[0].length);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);

  return {
    body,
    frontmatter: frontmatter as MdxFrontmatter,
    hasFrontmatter: true,
  };
}
