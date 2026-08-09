import { get_encoding, type Tiktoken } from "@dqbd/tiktoken";
import { at } from "./numerical.js";

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

let _encoding: Tiktoken | null = null;

function getEncoding(): Tiktoken {
  if (_encoding === null) {
    _encoding = get_encoding("cl100k_base");
  }
  return _encoding;
}

/**
 * Smart text chunker. Splits text into chunks by sentences,
 * respecting max token limits with overlap.
 * @param {string} text - Text to chunk
 * @param {{ maxTokens?: number, overlapTokens?: number }} [options]
 * @returns {string[]}
 */
function chunkText(
  text: string | null | undefined,
  options: ChunkOptions = {},
): string[] {
  if (!text) return [];

  const maxTokens = options.maxTokens || 6800; // 8000 * 0.85
  const overlapTokens = options.overlapTokens || Math.floor(maxTokens * 0.1);
  const encoding = getEncoding();

  const sentences = text.split(/(?<=[。？！.!?\n])/g);
  const chunks: string[] = [];
  let currentChunk = "";
  let currentTokens = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = at(sentences, i, "sentences");
    let sentenceTokens = encoding.encode(sentence).length;

    if (sentenceTokens > maxTokens) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
        currentTokens = 0;
      }
      const forceSplitChunks = forceSplitLongText(
        sentence,
        maxTokens,
        overlapTokens,
        encoding,
      );
      chunks.push(...forceSplitChunks);
      continue;
    }

    if (currentTokens + sentenceTokens > maxTokens) {
      chunks.push(currentChunk.trim());

      let overlapChunk = "";
      let overlapTokenCount = 0;
      for (let j = i - 1; j >= 0; j--) {
        const prevSentence = at(sentences, j, "sentences");
        const prevSentenceTokens = encoding.encode(prevSentence).length;
        if (overlapTokenCount + prevSentenceTokens > overlapTokens) break;
        overlapChunk = prevSentence + overlapChunk;
        overlapTokenCount += prevSentenceTokens;
      }
      currentChunk = overlapChunk;
      currentTokens = overlapTokenCount;
    }

    currentChunk += sentence;
    currentTokens += sentenceTokens;
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

function forceSplitLongText(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  encoding: Tiktoken,
): string[] {
  const chunks: string[] = [];
  const tokens = encoding.encode(text);
  const safeOverlap = Math.min(overlapTokens, Math.max(0, maxTokens - 1));
  const decoder = new TextDecoder("utf-8");

  let start = 0;
  while (start < tokens.length) {
    let end = Math.min(start + maxTokens, tokens.length);

    if (end < tokens.length) {
      const chunkTokens = tokens.slice(start, end);
      let chunkTextStr = decoder.decode(encoding.decode(chunkTokens));

      const breakPoints = ["\n", "。", "！", "？", "，", "；", "：", " ", "\t"];
      let bestBreakPoint = -1;

      for (
        let i = chunkTextStr.length - 1;
        i >= Math.max(0, chunkTextStr.length - 200);
        i--
      ) {
        if (breakPoints.includes(at(chunkTextStr, i, "decoded chunk"))) {
          bestBreakPoint = i + 1;
          break;
        }
      }

      let finalChunkText = chunkTextStr;
      if (bestBreakPoint > 0) {
        const candidateText = chunkTextStr.substring(0, bestBreakPoint);
        const newTokens = encoding.encode(candidateText);
        if (newTokens.length > safeOverlap || newTokens.length === end - start) {
          finalChunkText = candidateText;
          end = start + newTokens.length;
        }
      }

      chunks.push(finalChunkText.trim());
    } else {
      const chunkTokens = tokens.slice(start);
      chunks.push(decoder.decode(encoding.decode(chunkTokens)).trim());
    }

    start = Math.max(start + 1, end - safeOverlap);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export { chunkText };
