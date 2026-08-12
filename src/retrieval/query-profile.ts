import type { UnknownRecord } from "../types/common.js";
import type { QueryProfile, QueryProfileSignals } from "./query-planner-types.js";

const SIGNAL_PATTERNS: Record<keyof QueryProfileSignals, RegExp> = {
  relational:
    /关联|相关|联系|连接|指向|依赖|因果|来源|为什么|因为|链路|关系|related|relate|connect|link|depend|cause|because/i,
  sequence:
    /路径|沿着|连续|演化|脉络|时间线|顺序|前后|轨迹|sequence|path|timeline|before|after|trajectory/i,
  temporal:
    /最近|今天|昨日|昨天|明天|现在|之前|以后|历史|时间|何时|latest|recent|today|yesterday|when|time/i,
  topical: /标签|主题|概念|关键词|类别|分类|tag|topic|concept|keyword|category/i,
  directReference: /这份|该文|这段|原文|直接|锚点|引用|source|direct|anchor|exact/i,
  question:
    /[?？]|如何|什么|哪些|为何|请找|查找|寻找|解释|why|what|how|which|find|search/i,
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

const RELATION_HINTS = [
  "关联",
  "相关",
  "联系",
  "连接",
  "指向",
  "依赖",
  "因果",
  "来源",
  "链路",
  "关系",
  "路径",
  "沿着",
  "related",
  "connect",
  "depend",
  "cause",
  "source",
  "path",
];

const CJK_CONCEPT_BOUNDARY =
  /沿着|关联|相关|联系|连接|指向|依赖|因果|来源|为什么|因为|链路|关系|路径|连续|演化|脉络|时间线|顺序|前后|轨迹|最近|今天|昨日|昨天|明天|现在|之前|以后|历史|时间|何时|标签|主题|概念|关键词|类别|分类|这份|该文|这段|原文|直接|锚点|引用|如何|什么|哪些|为何|请找|查找|寻找|解释|的|与|和|及|在|是|了|着|从|为|将|被|对/g;

function tokenizeQuery(normalized: string): string[] {
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.:/@#-]*/gi)) {
    tokens.push(match[0].toLowerCase());
  }

  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0];
    tokens.push(run);
    const chars = Array.from(run);
    for (let width = 2; width <= Math.min(8, chars.length); width += 1) {
      for (let index = 0; index + width <= chars.length; index += 1) {
        tokens.push(chars.slice(index, index + width).join(""));
      }
    }
  }
  return unique(tokens);
}

function extractConcepts(tokens: readonly string[], normalized: string): string[] {
  const cueWords =
    /沿着|关联|相关|联系|连接|指向|依赖|因果|来源|为什么|因为|链路|关系|路径|连续|演化|脉络|时间线|顺序|前后|轨迹|最近|今天|昨日|昨天|明天|现在|之前|以后|历史|时间|何时|标签|主题|概念|关键词|类别|分类|这份|该文|这段|原文|直接|锚点|引用|如何|什么|哪些|为何|请找|查找|寻找|解释/;
  const cjkConcepts: string[] = [];
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const segments = (match[0] || "")
      .split(CJK_CONCEPT_BOUNDARY)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length >= 2);
    for (const segment of segments) {
      cjkConcepts.push(segment);
      const chars = Array.from(segment);
      for (let width = 2; width <= Math.min(8, chars.length); width += 1) {
        for (let index = 0; index + width <= chars.length; index += 1) {
          cjkConcepts.push(chars.slice(index, index + width).join(""));
        }
      }
    }
  }

  return unique([
    ...cjkConcepts,
    ...tokens.filter(
      (token) =>
        !/^[\u4e00-\u9fff]+$/.test(token) &&
        token.length >= 2 &&
        !cueWords.test(token) &&
        !/^\d+$/.test(token),
    ),
  ]).slice(0, 32);
}

function extractEntities(normalized: string, tokens: readonly string[]): string[] {
  const quoted = [...normalized.matchAll(/["“”']([^"“”']{2,80})["“”']/g)].map(
    (match) => match[1] || "",
  );
  const pathLike = tokens.filter(
    (token) => /\.(?:md|mdx|txt)$/i.test(token) || /^memory(?::|:\/\/)/i.test(token),
  );
  return unique([...quoted, ...pathLike]).slice(0, 24);
}

function extractTimeConstraints(normalized: string): UnknownRecord | null {
  const relative = normalized.match(
    /(?:最近|近来|今天|昨日|昨天|明天|上周|本周|去年|今年|过去\s*\d+\s*(?:天|周|月|年)|最近\s*\d+\s*(?:天|周|月|年)|last\s+\d+\s+(?:days?|weeks?|months?|years?))/i,
  )?.[0];
  return relative ? { expression: relative, kind: "relative" } : null;
}

/** Turn ordinary natural-language text into planner-visible signals. */
export function profileNaturalLanguageQuery(
  query: string,
  hints: Partial<QueryProfile> = {},
): QueryProfile {
  const raw = String(query ?? "");
  const normalized = raw.trim().replace(/\s+/g, " ");
  const signals = Object.fromEntries(
    (Object.keys(SIGNAL_PATTERNS) as Array<keyof QueryProfileSignals>).map((key) => [
      key,
      SIGNAL_PATTERNS[key].test(normalized),
    ]),
  ) as unknown as QueryProfileSignals;
  const tokens = tokenizeQuery(normalized);
  const relationHints = unique(
    RELATION_HINTS.filter((hint) =>
      normalized.toLowerCase().includes(hint.toLowerCase()),
    ),
  );
  const concepts = unique([
    ...extractConcepts(tokens, normalized),
    ...(Array.isArray(hints.concepts) ? hints.concepts : []),
  ]).slice(0, 64);
  const wantsDirectEvidence = hints.wantsDirectEvidence ?? signals.directReference;
  const wantsRelatedContext =
    hints.wantsRelatedContext ?? (signals.relational || signals.sequence);
  return {
    raw,
    normalized,
    tokens,
    concepts,
    entities: unique([
      ...extractEntities(normalized, tokens),
      ...(Array.isArray(hints.entities) ? hints.entities : []),
    ]).slice(0, 24),
    relationHints: unique([
      ...relationHints,
      ...(Array.isArray(hints.relationHints) ? hints.relationHints : []),
    ]).slice(0, 24),
    timeConstraints:
      hints.timeConstraints === undefined
        ? extractTimeConstraints(normalized)
        : hints.timeConstraints,
    wantsDirectEvidence,
    wantsRelatedContext,
    complexity:
      hints.complexity ??
      Math.min(1, (tokens.length + concepts.length + relationHints.length * 2) / 32),
    confidence:
      hints.confidence ??
      Math.min(0.99, 0.55 + Object.values(signals).filter(Boolean).length * 0.08),
    signals,
  };
}
