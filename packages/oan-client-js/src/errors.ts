/**
 * Uniform error type for OAN REST calls: every server error response has the shape
 * { error: string, code: string }, and this class condenses the HTTP status code plus that
 * shape into one exception carrying status/code, for callers to catch and inspect uniformly.
 */
export class OanApiError extends Error {
  /** HTTP status code */
  readonly status: number;
  /** Server error code (e.g. VALIDATION_ERROR / INTERNAL_ERROR); undefined when the response body lacks the field */
  readonly code?: string;
  /** Raw response body (JSON-parsed when possible), a fallback for callers needing more context */
  readonly body?: unknown;

  constructor(status: number, message: string, options: { code?: string; body?: unknown } = {}) {
    super(message);
    this.name = 'OanApiError';
    this.status = status;
    this.code = options.code;
    this.body = options.body;
  }
}

/**
 * Event envelope decoding failure (missing the seq or eventId field required for backfill/dedup).
 * Distinct from OanApiError: this means the protocol-level data itself is invalid, not that an
 * HTTP call failed.
 */
export class OanProtocolError extends Error {
  readonly raw: unknown;

  constructor(message: string, raw: unknown) {
    super(message);
    this.name = 'OanProtocolError';
    this.raw = raw;
  }
}
