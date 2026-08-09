"use strict";

import type { EmbeddingProviderContract, EmbeddingVector } from "../../src/types.js";
import { at } from "../../src/utils/numerical.js";

/**
 * FakeEmbeddingProvider — 离线确定性伪嵌入。
 *
 * 无需任何 API Key 与网络：
 *  - 将文本按字符 bigram + 单字哈希到 128 维
 *  - 相似文本得到相似向量（余弦相似度与词面重合度相关）
 *  - L2 归一化，纯函数，结果可复现
 *
 * 接口与 memoria 的 EmbeddingProvider 完全一致：
 *   getDimension() -> number
 *   async embedBatch(texts) -> Array<Float32Array|null>
 */

const DIM = 128;

function hashStr(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class FakeEmbeddingProvider implements EmbeddingProviderContract {
  name: string;
  dimension: number;

  constructor(dimension = DIM) {
    this.name = "fakeEmbeddingProvider";
    this.dimension = dimension;
  }

  getDimension() {
    return this.dimension;
  }

  embed(text: string): EmbeddingVector {
    const raw = String(text == null ? "" : text)
      .toLowerCase()
      .replace(/\s+/g, " ");
    const vec = new Float32Array(this.dimension);

    for (let i = 0; i < raw.length - 1; i++) {
      const gram = raw.slice(i, i + 2);
      if (gram.includes(" ")) continue;
      vec[hashStr(gram) % this.dimension] += 1;
    }
    for (const ch of raw) {
      if (ch !== " ") {
        vec[hashStr("c:" + ch) % this.dimension] += 0.6;
      }
    }

    let norm = 0;
    for (let i = 0; i < this.dimension; i++) {
      const value = at(vec, i, "fake embedding");
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dimension; i++)
      vec[i] = at(vec, i, "fake embedding") / norm;
    return vec;
  }

  /** 保证返回数组长度 === 输入长度（失败项为 null，本实现不会失败） */
  async embedBatch(texts: readonly string[] = []): Promise<(EmbeddingVector | null)[]> {
    return texts.map((text) => (text == null ? null : this.embed(text)));
  }
}

export { FakeEmbeddingProvider };
