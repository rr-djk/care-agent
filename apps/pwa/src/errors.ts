export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly text: string,
    readonly field_ids?: string[], // fields_need_review
  ) {
    super(text);
  }
}
