import type { z } from "zod";
import { anthropicProvider } from "./anthropic";
import { AiError } from "./errors";
import { describeIssues, extractJson } from "./json";
import { openrouterProvider } from "./openrouter";
import { ProviderError, testHooks, type ImageMediaType, type Part, type Provider, type ProviderResult } from "./transport";
import type { AiConfig, AiContent, AiUsage, OnUsage } from "./types";

export { AiError } from "./errors";
export type { AiErrorCode } from "./errors";

/**
 * Anthropic: Claude Opus 5.5, the current default Claude model (vision + structured JSON).
 * OpenRouter: the same model through OpenRouter, so both providers answer alike (any OpenRouter id with image input works).
 */
export const DEFAULT_MODELS: Record<AiConfig["provider"], string> = {
  anthropic: "claude-opus-5-5",
  openrouter: "anthropic/claude-opus-5.5",
};

/** Invalid answers are sent back for a corrected one at most this many times. */
export const MAX_REPAIRS = 2;
/** HTTP attempts per call: the first + retries of transient errors (408, 429, 5xx, 529, network). */
export const MAX_ATTEMPTS = 4;
/** Larger images are not sent (base64 grows them by a third; providers cap images at about 5 MB). */
export const MAX_IMAGE_BYTES = 3_500_000;
export const DEFAULT_MAX_TOKENS = 16_000;
/** The previous answer quoted in a repair request is cut beyond this. */
const MAX_QUOTED_ANSWER = 60_000;

const PROVIDERS: Record<AiConfig["provider"], Provider> = { anthropic: anthropicProvider, openrouter: openrouterProvider };

const JSON_RULE =
  "Answer with the JSON value only (optionally in one ```json fenced block): no comments, no text before or after it.";

/** One call that must answer JSON matching the schema; invalid answers are sent back for repair at most twice. */
export async function completeJson<S extends z.ZodType>(
  cfg: AiConfig,
  req: { system: string; content: AiContent; schema: S; maxTokens?: number; signal?: AbortSignal; purpose: string },
  onUsage?: OnUsage,
): Promise<z.infer<S>> {
  const provider = PROVIDERS[cfg.provider];
  if (!provider) throw new AiError(`unknown AI provider "${String(cfg.provider)}"`, "config");
  if (!cfg.apiKey?.trim()) throw new AiError(`no API key for ${cfg.provider}`, "config");
  const model = cfg.model?.trim() || DEFAULT_MODELS[cfg.provider];
  const purpose = req.purpose || "ai";
  const mask = masker(cfg.apiKey);
  const parts = toParts(req.content);
  const system = `${req.system.trim()}\n\n${JSON_RULE}`;
  const maxTokens = Math.max(256, Math.floor(req.maxTokens ?? DEFAULT_MAX_TOKENS));

  let lastAnswer = "";
  let problem = "";
  for (let round = 0; round <= MAX_REPAIRS; round++) {
    const request = round === 0 ? parts : [...parts, { type: "text" as const, text: repairNote(lastAnswer, problem) }];
    const result = await callWithRetries(
      provider,
      { model, apiKey: cfg.apiKey, system, parts: request, maxTokens, signal: req.signal },
      { provider: cfg.provider, purpose, mask, onUsage },
    );
    const checked = await check(result, req.schema);
    if (checked.ok) return checked.value;
    lastAnswer = result.text;
    problem = checked.problem;
  }
  throw new AiError(mask(`${purpose}: no valid answer after ${MAX_REPAIRS} repairs (${cut(problem, 300)})`), "invalid_answer");
}

type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

async function check<S extends z.ZodType>(result: ProviderResult, schema: S): Promise<Checked<z.infer<S>>> {
  const cutOff = result.truncated ? " The answer was cut off at the output limit: answer shorter (fewer items, no repeated values)." : "";
  const json = extractJson(result.text);
  if (!json.ok) return { ok: false, problem: `${json.reason}.${cutOff}` };
  const parsed = await schema.safeParseAsync(json.value);
  if (!parsed.success) return { ok: false, problem: `the JSON does not match the expected shape: ${describeIssues(parsed.error)}.${cutOff}` };
  return { ok: true, value: parsed.data as z.infer<S> };
}

function repairNote(previous: string, problem: string): string {
  const quoted = previous.length > MAX_QUOTED_ANSWER ? `${previous.slice(0, MAX_QUOTED_ANSWER)}\n…(cut)` : previous;
  return [
    "## Your previous answer could not be used",
    problem,
    "",
    "Previous answer:",
    "<<<",
    quoted || "(empty)",
    ">>>",
    "",
    "Answer again with the complete corrected JSON (the whole answer, not only the fixed part).",
  ].join("\n");
}

async function callWithRetries(
  provider: Provider,
  request: Parameters<Provider>[0],
  ctx: { provider: AiConfig["provider"]; purpose: string; mask: (s: string) => string; onUsage?: OnUsage },
): Promise<ProviderResult> {
  const { signal } = request;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new AiError(`${ctx.purpose}: cancelled`, "cancelled");
    try {
      const result = await provider(request);
      await report(ctx.onUsage, { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd, ok: true, purpose: ctx.purpose });
      return result;
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(`${ctx.provider}: ${cut(e instanceof Error ? e.message : String(e), 300)}`);
      await report(ctx.onUsage, {
        model: err.usage?.model ?? request.model,
        inputTokens: err.usage?.inputTokens ?? 0,
        outputTokens: err.usage?.outputTokens ?? 0,
        costUsd: err.usage ? err.usage.costUsd : 0,
        ok: false,
        purpose: ctx.purpose,
      });
      if (err.kind === "cancelled" || signal?.aborted) throw new AiError(`${ctx.purpose}: cancelled`, "cancelled");
      if (err.kind === "refused") throw new AiError(ctx.mask(`${ctx.purpose}: ${err.message}`), "refused", err.status);
      if (err.retryable && attempt < MAX_ATTEMPTS) {
        await sleep(backoff(attempt, err.retryAfterMs), signal);
        continue;
      }
      const tries = attempt > 1 ? ` (after ${attempt} attempts)` : "";
      throw new AiError(ctx.mask(`${ctx.purpose}: ${err.message}${tries}`), "provider", err.status);
    }
  }
}

/** Usage accounting must not break the call: a failing callback is ignored. */
async function report(onUsage: OnUsage | undefined, usage: AiUsage): Promise<void> {
  if (!onUsage) return;
  try {
    await onUsage(usage);
  } catch {
    /* ignored */
  }
}

function backoff(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 60_000);
  return Math.min(30_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const fake = testHooks().sleep;
  if (fake) return fake(ms);
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Text and images of the user turn; an image over the size cap is replaced by a note. */
export function toParts(content: AiContent): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const parts: Part[] = [];
  for (const c of content) {
    if (c.type === "text") {
      if (c.text) parts.push({ type: "text", text: c.text });
    } else if (c.png && c.png.length > 0) {
      if (c.png.length > MAX_IMAGE_BYTES) {
        const mb = (n: number) => (n / 1_000_000).toFixed(1);
        parts.push({ type: "text", text: `[An image was left out: ${mb(c.png.length)} MB is over the ${mb(MAX_IMAGE_BYTES)} MB limit.]` });
      } else {
        parts.push({ type: "image", data: c.png, mediaType: mediaType(c.png) });
      }
    }
  }
  if (!parts.length) parts.push({ type: "text", text: "(no content)" });
  return parts;
}

/** The caller sends PNG; a JPEG/WebP/GIF buffer is labeled as what it is (a wrong label is a 400). */
function mediaType(buf: Buffer): ImageMediaType {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return "image/png";
}

/** Replaces the key in a message (provider error bodies may echo what they got). */
function masker(apiKey: string): (s: string) => string {
  const key = apiKey.trim();
  return (s: string) => (key.length >= 4 ? s.split(key).join("***") : s);
}

function cut(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
