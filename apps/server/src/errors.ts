/** An error that maps to an HTTP response `{ code, text }` (plus optional extra keys). */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    readonly code: string,
    readonly text: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(text);
    this.name = 'ApiError';
  }
}
