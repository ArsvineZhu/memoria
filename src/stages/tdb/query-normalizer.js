'use strict';

const Stage = require('../../core/stage');

// Question-word heuristics shared by the zh/en detection.
const QUESTION_MARKERS = [
  '?', '？',
  '为什么', '为何', '怎么', '如何', '是否', '有没有', '哪', '哪些',
  '多少', '几', '谁', '什么', '是什么', '怎么', '吗',
  'how', 'why', 'what', 'where', 'when', 'who', 'which',
  'is ', 'are ', 'can ', 'do ', 'does ', 'did ', 'should '
];

/**
 * TDB query-normalization stage.
 *
 * Classifies the raw query into 'question' vs 'keyword' mode (a question
 * ends with a question mark or contains a question marker) and exposes
 * the trimmed query + token hints for downstream stages.
 *
 * Input:  { query }
 * Output: { query, mode: 'question'|'keyword', question: boolean,
 *           questionMarkers?: string[] }
 */
class TDBQueryNormalizerStage extends Stage {
  constructor() {
    super();
    this.name = 'tdbQueryNormalizer';
  }

async process(input, ctx = {}) {
    const info = input || {};
    const raw = typeof info.query === 'string' ? info.query : '';
    const query = raw.trim();
    const config = ctx.config || {};

    if (config.tdbForceMode === 'question' || config.tdbForceMode === 'keyword') {
      const forced = config.tdbForceMode;
      return { ...info, query, mode: forced, question: forced === 'question', normalized: query };
    }

    const markers = QUESTION_MARKERS.filter(m => query.includes(m));
    const question = markers.length > 0;
    return {
      ...info,
      query,
      normalized: query,
      mode: question ? 'question' : 'keyword',
      question,
      markers
    };
  }
}

module.exports = TDBQueryNormalizerStage;