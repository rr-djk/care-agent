export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly text: string,
    readonly field_ids?: string[], // fields_need_review
    readonly status?: number, // HTTP status; absent for network failures
  ) {
    super(text);
  }
}

/** Device unlock failures (wrong PIN, locked, no local profile...). `retryInMs` when `code` is `locked`. */
export class DeviceError extends Error {
  constructor(
    readonly code: string,
    readonly retryInMs = 0,
  ) {
    super(code);
  }
}
