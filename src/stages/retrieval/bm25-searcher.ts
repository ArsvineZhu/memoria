import type {
  ChunkCandidate,
  ChunkRow,
  MemoryConfig,
  PipelineContextLike,
  PipelineData,
  SearchCorpusChunk,
  Tokenizer,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";

// Default BM25 constants (mirror of LightMemo.BM25Ranker).
const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

// Tokens must contain at least one Han / alnum character (mirror of
// LightMemo._isBM25TokenLikeWord).
const TOKEN_LIKE = /[\p{Script=Han}a-z0-9_]/u;

/**
 * Sparse keyword retrieval over the whole chunk corpus using BM25.
 *
 * Mirrors the LightMemo BM25 pre-filter: query text is tokenized (a
 * config.tokenizer hook may replace the default whitespace + CJK-bigram
 * splitter), IDF is computed over the corpus, and every chunk whose BM25
 * score is positive is returned, sorted desc, capped by bm25PoolK.
 *
 * Input: { query, tokens? } — pre-tokenized input may pass tokens directly.
 *
 * Config (ctx.config):
 *   - tokenizer:   (text) => string[] custom tokenizer (sync or async)
 *   - stopWords:   array of tokens ignored during scoring
 *   - bm25K1:      term-frequency saturation (default 1.5)
 *   - bm25B:       length-normalization factor (default 0.75)
 *   - bm25PoolK:   max number of scored chunks returned (default 50)
 *
 * Output: { bm25Results: [{ chunkId, score }] } sorted desc.
 */
class BM25SearcherStage extends Stage {
  constructor() {
    super();
    this.name = "bm25Searcher";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "bm25Results" | "metadataStoreMissing"> & {
      bm25Results: ChunkCandidate[];
      metadataStoreMissing?: boolean;
    }
  > {
    const info = input || {};
    const metadataStore = ctx.metadataStore;

    if (!metadataStore) {
      return { ...info, bm25Results: [], metadataStoreMissing: true };
    }

    const config = ctx.config || {};
    const tokenizer: (text: string) => Promise<string[]> =
      typeof config.tokenizer === "function"
        ? this._wrapTokenizer(config.tokenizer)
        : async (text: string) => this._tokenize(text);
    const stopWords = new Set(
      Array.isArray(config.stopWords)
        ? config.stopWords.map((w: string) => String(w).toLowerCase())
        : [],
    );

    // Query tokens: input.tokens wins, otherwise tokenize input.query.
    let tokens: string[] = [];
    if (Array.isArray(info.tokens) && info.tokens.length > 0) {
      tokens = info.tokens.map((t) => String(t).toLowerCase());
    } else {
      const query = typeof info.query === "string" ? info.query : "";
      tokens = this._filterTokens(await tokenizer(query), stopWords);
    }
    if (tokens.length === 0) {
      return { ...info, bm25Results: [] };
    }

    // Corpus: chunk id -> token list.
    let chunks: Array<ChunkRow | SearchCorpusChunk> = [];
    try {
      if (typeof metadataStore.getSearchCorpus === "function") {
        chunks = await metadataStore.getSearchCorpus(
          Array.isArray(info.resolvedIndexNames) ? info.resolvedIndexNames : undefined,
        );
      } else {
        const explicitScope =
          Array.isArray(info.indexNames) ||
          Array.isArray(info.diaryNames) ||
          typeof info.diaryName === "string" ||
          Array.isArray(info.libraries);
        if (explicitScope && Array.isArray(info.resolvedIndexNames)) {
          throw new Error("Metadata provider cannot honor scoped search.");
        }
        if (typeof metadataStore.getAllChunks !== "function") {
          return { ...info, bm25Results: [], metadataStoreMissing: true };
        }
        chunks = await metadataStore.getAllChunks();
      }
    } catch (e) {
      throw asMemoriaError(
        e,
        "persistence",
        "Metadata store failed while loading chunks for BM25 search.",
        { retryable: true },
      );
    }
    if (!chunks || chunks.length === 0) {
      return { ...info, bm25Results: [] };
    }

    const docs: Array<{ chunkId: number; tokens: string[] }> = [];
    for (const chunk of chunks) {
      const chunkId = Number(chunk.id);
      if (!Number.isFinite(chunkId)) continue;
      docs.push({
        chunkId,
        tokens: this._filterTokens(await tokenizer(chunk.content), stopWords),
      });
    }
    if (docs.length === 0) return { ...info, bm25Results: [] };

    const N = docs.length;
    const k1 = Number(config.bm25K1) || DEFAULT_K1;
    const b = Number(config.bm25B) || DEFAULT_B;
    const poolK = Math.max(1, Math.round(Number(config.bm25PoolK) || 50));

    // Document frequency + IDF (BM25 standard formula).
    const docFreq = new Map<string, number>();
    for (const doc of docs) {
      const seen = new Set(doc.tokens);
      for (const token of seen) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
    const idf = new Map<string, number>();
    for (const [token, df] of docFreq) {
      idf.set(token, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    }

    let avgDocLength = 0;
    for (const doc of docs) avgDocLength += doc.tokens.length;
    avgDocLength = avgDocLength / Math.max(1, N);

    // Score every chunk once, keep strictly positive hits.
    const scored: ChunkCandidate[] = [];
    for (const doc of docs) {
      const score = this.scoreDoc(tokens, doc.tokens, idf, avgDocLength, k1, b);
      if (score > 0) {
        scored.push({ chunkId: doc.chunkId, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
    return { ...info, bm25Results: scored.slice(0, poolK) };
  }

  /**
   * BM25 score of a single document against the query tokens.
   * @param {string[]} queryTokens
   * @param {string[]} docTokens
   * @param {Map<string,number>} idf
   * @param {number} avgDocLength
   * @param {number} k1
   * @param {number} b
   * @returns {number}
   */
  scoreDoc(
    queryTokens: readonly string[],
    docTokens: readonly string[],
    idf: Map<string, number>,
    avgDocLength: number,
    k1: number,
    b: number,
  ): number {
    const docLength = docTokens.length;
    const termFreq = new Map<string, number>();
    for (const token of docTokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    let total = 0;
    for (const token of queryTokens) {
      const tf = termFreq.get(token) || 0;
      if (tf === 0) continue;
      const idfValue = idf.get(token) || 0;
      const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
      total += idfValue * ((tf * (k1 + 1)) / denominator);
    }
    return total;
  }

  /**
   * Default tokenizer: ASCII word-like tokens + CJK runs split into
   * character bigrams plus single characters (recall-friendly fallback
   * when no jieba-style segmenter is available).
   * @param {string} text
   * @returns {string[]}
   */
  _tokenize(text: string): string[] {
    const raw = String(text || "").toLowerCase();

    const words = raw.match(/[a-z0-9_][a-z0-9_.:/@#-]*/g) || [];

    const cjkTokens: string[] = [];
    const cjkRuns = raw.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of cjkRuns) {
      const chars = [...run];
      if (chars.length === 1) {
        cjkTokens.push(at(chars, 0, "CJK characters"));
        continue;
      }
      for (let i = 0; i < chars.length; i++) {
        if (i + 1 < chars.length) {
          cjkTokens.push(
            at(chars, i, "CJK characters") + at(chars, i + 1, "CJK characters"),
          );
        }
        cjkTokens.push(at(chars, i, "CJK characters"));
      }
    }

    return [...words, ...cjkTokens].filter((token) => TOKEN_LIKE.test(token));
  }

  _wrapTokenizer(fn: Tokenizer): (text: string) => Promise<string[]> {
    // Accept sync or async tokenizers.
    return async (text) => {
      const result = await fn(text);
      return (Array.isArray(result) ? result : []).map((t) => String(t).toLowerCase());
    };
  }

  _filterTokens(tokens: readonly string[], stopWords: ReadonlySet<string>): string[] {
    if (!Array.isArray(tokens)) return [];
    return tokens.filter((token) => token.length > 0 && !stopWords.has(token));
  }
}

export default BM25SearcherStage;
