/**
 * Internal: Anthropic provider (official SDK). One streamed request per call (no SDK retries: the caller retries and
 * reports usage per HTTP call). Server-side refusal fallback is on ("default" chain, a no-op on models without one).
 */
import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { costUsd } from "./pricing";
import {
  isRetryableStatus,
  parseRetryAfter,
  ProviderError,
  shortText,
  testHooks,
  type Provider,
  type ProviderRequest,
  type ProviderResult,
  type ProviderUsage,
} from "./transport";

type StreamParams = BetaMessageStreamParams;

/** The part of the SDK client this provider uses (a fake implements it in tests). */
export interface AnthropicLike {
  beta: {
    messages: {
      stream(body: StreamParams, options?: { signal?: AbortSignal | null }): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** API error types (mid-stream errors carry no status) worth another try */
const RETRYABLE_TYPES = new Set(["overloaded_error", "api_error", "rate_limit_error", "timeout_error"]);

function client(apiKey: string): AnthropicLike {
  const fake = testHooks().anthropic;
  if (fake) return fake(apiKey);
  return new Anthropic({ apiKey, maxRetries: 0, timeout: 10 * 60_000 });
}

/**
 * Effort of the Claude 5.x models (all accept low..max). Explicit, since Claude Opus 5.5 defaults to medium and other
 * models to high. Older models keep their default (some reject the parameter).
 */
function effortFor(model: string): "medium" | undefined {
  return /^claude-(fable|mythos|opus-5|sonnet-5|haiku-5)/.test(model) ? "medium" : undefined;
}

export const anthropicProvider: Provider = async (req: ProviderRequest): Promise<ProviderResult> => {
  const effort = effortFor(req.model);
  const params: StreamParams = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [
      {
        role: "user",
        content: req.parts.map((p) =>
          p.type === "text"
            ? { type: "text" as const, text: p.text }
            : { type: "image" as const, source: { type: "base64" as const, media_type: p.mediaType, data: p.data.toString("base64") } },
        ),
      },
    ],
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    ...(effort ? { output_config: { effort } } : {}),
  };

  let message: BetaMessage;
  try {
    // streamed: thinking + a long JSON answer can exceed what a non-streaming request may wait for
    message = await client(req.apiKey).beta.messages.stream(params, { signal: req.signal ?? null }).finalMessage();
  } catch (e) {
    throw toProviderError(e, req.signal);
  }

  const usage = usageOf(message, req.model);
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    throw new ProviderError(`the model declined the request${category ? ` (${category})` : ""}`, { kind: "refused", usage });
  }
  // text blocks only (thinking, fallback markers are skipped); after a mid-answer fallback the text continues seamlessly
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { ...usage, text, truncated: message.stop_reason === "max_tokens" };
};

function usageOf(message: BetaMessage, asked: string): ProviderUsage {
  const u = message.usage;
  const model = message.model || asked;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  return {
    model,
    inputTokens: u.input_tokens + cacheWrite + cacheRead,
    outputTokens: u.output_tokens,
    costUsd: costOf(message, model),
  };
}

/** Per model that ran (a fallback bills at its own rates), else the totals at the price of the answering model. */
function costOf(message: BetaMessage, model: string): number | null {
  const u = message.usage;
  const iterations = Array.isArray(u.iterations) ? u.iterations : [];
  const sampled = iterations.filter((it) => it.type === "message" || it.type === "fallback_message");
  if (sampled.length > 1) {
    let total = 0;
    for (const it of sampled) {
      const c = costUsd(("model" in it && typeof it.model === "string" && it.model) || model, {
        input: it.input_tokens,
        output: it.output_tokens,
        cacheWrite: it.cache_creation_input_tokens ?? 0,
        cacheRead: it.cache_read_input_tokens ?? 0,
      });
      if (c === null) return null;
      total += c;
    }
    return Math.round(total * 1e8) / 1e8;
  }
  return costUsd(model, {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  });
}

function toProviderError(e: unknown, signal: AbortSignal | undefined): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof APIUserAbortError || signal?.aborted) return new ProviderError("cancelled", { kind: "cancelled" });
  if (e instanceof APIConnectionError) return new ProviderError(`anthropic not reachable (${shortText(e.message, 160)})`, { retryable: true });
  if (e instanceof APIError) {
    const body = e.error as { error?: { type?: string; message?: string } } | undefined;
    const type = body?.error?.type;
    const detail = shortText(body?.error?.message || e.message || "error", 300);
    const status = typeof e.status === "number" ? e.status : undefined;
    const retryable = status !== undefined ? isRetryableStatus(status) : !!type && RETRYABLE_TYPES.has(type);
    return new ProviderError(`anthropic ${status ?? type ?? "error"}${hint(status)}: ${detail}`, {
      retryable,
      status,
      retryAfterMs: parseRetryAfter(e.headers?.get?.("retry-after")),
    });
  }
  return new ProviderError(`anthropic: ${shortText(e instanceof Error ? e.message : String(e), 300)}`);
}

function hint(status: number | undefined): string {
  switch (status) {
    case 401:
      return " (check the API key)";
    case 403:
      return " (the key may not use this model)";
    case 404:
      return " (unknown model?)";
    case 413:
      return " (request too large: smaller image or less text)";
    default:
      return "";
  }
}
