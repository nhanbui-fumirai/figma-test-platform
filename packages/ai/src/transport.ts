/**
 * Internal: what a provider gets and gives back, and the test hooks (fake fetch, fake Anthropic client, instant sleep).
 * Nothing here is exported from the package entry.
 */
import type { AnthropicLike } from "./anthropic";

export type Part = { type: "text"; text: string } | { type: "image"; data: Buffer; mediaType: ImageMediaType };
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ProviderRequest {
  model: string;
  apiKey: string;
  system: string;
  /** one user turn */
  parts: Part[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  /** the model that answered (may differ from the one asked: aliases, fallbacks) */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface ProviderResult extends ProviderUsage {
  text: string;
  /** the answer stopped at the output limit */
  truncated: boolean;
}

export type Provider = (req: ProviderRequest) => Promise<ProviderResult>;

/** One failed HTTP call. The message is short and must not contain the key (it is masked again by the caller). */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /** tokens billed by the failed call, when the provider says */
  readonly usage: ProviderUsage | undefined;
  readonly kind: "http" | "refused" | "cancelled";

  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number; retryAfterMs?: number; usage?: ProviderUsage; kind?: "http" | "refused" | "cancelled" } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.usage = opts.usage;
    this.kind = opts.kind ?? "http";
  }
}

/** HTTP statuses worth another try (529: Anthropic overloaded). */
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

/** Retry-After as milliseconds (seconds or an HTTP date), undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** A provider message cut to one short line. */
export function shortText(text: string, max = 300): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// ---------------------------------------------------------------- test hooks

export interface TestHooks {
  /** replaces globalThis.fetch for the OpenRouter provider */
  fetch?: typeof fetch;
  /** replaces the Anthropic SDK client */
  anthropic?: (apiKey: string) => AnthropicLike;
  /** replaces the waits between retries */
  sleep?: (ms: number) => Promise<void>;
}

let hooks: TestHooks = {};

/** For tests only: inject fakes (no network). Pass {} to reset. */
export function setTestHooks(next: TestHooks): void {
  hooks = { ...next };
}

export function testHooks(): Readonly<TestHooks> {
  return hooks;
}
