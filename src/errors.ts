export type MemoriaErrorCode =
  | "configuration"
  | "ingestion"
  | "persistence"
  | "embedding"
  | "vector_backend"
  | "integrity"
  | "retrieval"
  | "lifecycle";

export interface MemoriaErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** Stable, low-cardinality error boundary for library consumers. */
export class MemoriaError extends Error {
  readonly code: MemoriaErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MemoriaErrorCode,
    message: string,
    options: MemoriaErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MemoriaError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function asMemoriaError(
  error: unknown,
  code: MemoriaErrorCode,
  message: string,
  options: Omit<MemoriaErrorOptions, "cause"> = {},
): MemoriaError {
  if (error instanceof MemoriaError) return error;
  return new MemoriaError(code, message, { ...options, cause: error });
}
