/** Why an AI call failed (the message is short and never contains the API key). */
export type AiErrorCode =
  /** no key, unknown provider */
  | "config"
  /** the provider failed (after the retries of transient errors) */
  | "provider"
  /** the model declined the request (safety classifiers) */
  | "refused"
  /** the answer was not JSON matching the schema, after the repairs */
  | "invalid_answer"
  /** the signal was aborted */
  | "cancelled";

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** HTTP status of the last failed call, when there was one */
  readonly status: number | undefined;

  constructor(message: string, code: AiErrorCode = "provider", status?: number) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = status;
  }
}
