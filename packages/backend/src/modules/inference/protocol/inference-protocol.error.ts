export class InferenceProtocolError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 499 | 500 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'InferenceProtocolError';
  }
}
