'use strict';

let _encoding = null;

function getEncoding() {
  if (!_encoding) {
    const { get_encoding } = require('@dqbd/tiktoken');
    _encoding = get_encoding('cl100k_base');
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
function chunkText(text, options = {}) {
  if (!text) return [];

  const maxTokens = options.maxTokens || 6800; // 8000 * 0.85
  const overlapTokens = options.overlapTokens || Math.floor(maxTokens * 0.1);
  const encoding = getEncoding();

  const sentences = text.split(/(?<=[。？！.!?\n])/g);
  const chunks = [];
  let currentChunk = '';
  let currentTokens = 0;

  for (let i = 0; i < sentences.length; i++) {
    let sentence = sentences[i];
    let sentenceTokens = encoding.encode(sentence).length;

    if (sentenceTokens > maxTokens) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
        currentTokens = 0;
      }
      const forceSplitChunks = forceSplitLongText(sentence, maxTokens, overlapTokens, encoding);
      chunks.push(...forceSplitChunks);
      continue;
    }

    if (currentTokens + sentenceTokens > maxTokens) {
      chunks.push(currentChunk.trim());

      let overlapChunk = '';
      let overlapTokenCount = 0;
      for (let j = i - 1; j >= 0; j--) {
        const prevSentence = sentences[j];
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

function forceSplitLongText(text, maxTokens, overlapTokens, encoding) {
  const chunks = [];
  const tokens = encoding.encode(text);
  const safeOverlap = Math.min(overlapTokens, Math.max(0, maxTokens - 1));
  const decoder = new TextDecoder('utf-8');

  let start = 0;
  while (start < tokens.length) {
    let end = Math.min(start + maxTokens, tokens.length);

    if (end < tokens.length) {
      const chunkTokens = tokens.slice(start, end);
      let chunkTextStr = decoder.decode(chunkTokens);

      const breakPoints = ['\n', '。', '！', '？', '，', '；', '：', ' ', '\t'];
      let bestBreakPoint = -1;

      for (let i = chunkTextStr.length - 1; i >= Math.max(0, chunkTextStr.length - 200); i--) {
        if (breakPoints.includes(chunkTextStr[i])) {
          bestBreakPoint = i + 1;
          break;
        }
      }

      let finalChunkText = chunkTextStr;
      if (bestBreakPoint > 0) {
        const candidateText = chunkTextStr.substring(0, bestBreakPoint);
        const newTokens = encoding.encode(candidateText);
        if (newTokens.length > safeOverlap || newTokens.length === (end - start)) {
          finalChunkText = candidateText;
          end = start + newTokens.length;
        }
      }

      chunks.push(finalChunkText.trim());
    } else {
      const chunkTokens = tokens.slice(start);
      chunks.push(decoder.decode(chunkTokens).trim());
    }

    start = Math.max(start + 1, end - safeOverlap);
  }

  return chunks.filter(chunk => chunk.length > 0);
}

module.exports = { chunkText };
