interface OpenAICompatibleResponseItem {
  index?: number;
  embedding?: readonly number[];
}

interface OpenAICompatibleResponse {
  error?: { message?: unknown; code?: unknown };
  data?: OpenAICompatibleResponseItem[];
}

export interface EmbeddingClientOptions {
  apiUrl: string;
  apiKey: string;
  getModelCandidates: () => string[];
}

function parseResponseBody(value: unknown): OpenAICompatibleResponse {
  if (value === null || typeof value !== "object") {
    throw new Error("response root is not an object");
  }

  const record = value as Record<string, unknown>;
  const data = Array.isArray(record.data)
    ? record.data.filter(
        (item): item is OpenAICompatibleResponseItem =>
          item !== null && typeof item === "object",
      )
    : undefined;

  return {
    error:
      record.error && typeof record.error === "object"
        ? (record.error as OpenAICompatibleResponse["error"])
        : undefined,
    data,
  };
}

export default class OpenAIEmbeddingClient {
  private readonly options: EmbeddingClientOptions;

  constructor(options: EmbeddingClientOptions) {
    this.options = options;
  }

  async sendBatch(
    batchTexts: readonly string[],
    batchNumber: number,
  ): Promise<number[][]> {
    const modelCandidates = this.options.getModelCandidates();
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= modelCandidates.length; attempt++) {
      const model = modelCandidates[attempt - 1];
      try {
        const response = await fetch(`${this.options.apiUrl}/v1/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({ model, input: batchTexts }),
        });
        const responseBodyText = await response.text();

        if (!response.ok) {
          if (response.status === 429) {
            const waitTime = Math.min(5000 * attempt, 15000);
            console.warn(
              `[OpenAICompatibleEmbedding] Batch ${batchNumber} model "${model}" ` +
                `rate limited (429). Switching fallback in ${waitTime / 1000}s...`,
            );
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            continue;
          }
          throw new Error(
            `API Error ${response.status}: ${responseBodyText.substring(0, 500)}`,
          );
        }

        let data: OpenAICompatibleResponse;
        try {
          data = parseResponseBody(JSON.parse(responseBodyText) as unknown);
        } catch (parseError) {
          throw new Error(
            `Failed to parse API response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            { cause: parseError },
          );
        }

        if (data.error) {
          const errorMessage =
            typeof data.error.message === "string"
              ? data.error.message
              : "provider_error";
          const errorCode =
            typeof data.error.code === "string" || typeof data.error.code === "number"
              ? String(data.error.code)
              : response.status;
          throw new Error(`API Error ${errorCode}: ${errorMessage}`);
        }
        if (!data.data || !Array.isArray(data.data)) {
          throw new Error(
            "Invalid API response structure: missing or invalid data field",
          );
        }

        return data.data
          .filter(
            (
              item,
            ): item is OpenAICompatibleResponseItem & {
              index: number;
              embedding: readonly number[];
            } => typeof item.index === "number" && Array.isArray(item.embedding),
          )
          .sort((a, b) => a.index - b.index)
          .map((item) => [...item.embedding]);
      } catch (error) {
        console.warn(
          `[OpenAICompatibleEmbedding] Batch ${batchNumber}, Model "${model}" failed ` +
            `(${attempt}/${modelCandidates.length}): ${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt === modelCandidates.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, baseDelay * attempt));
      }
    }

    throw new Error("No embedding model candidates configured");
  }
}
