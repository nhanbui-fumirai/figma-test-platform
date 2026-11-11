/**
 * Internal: OpenRouter provider (OpenAI chat-completions format, plain fetch). Usage accounting is asked for, so the
 * answer carries its cost. OpenRouter may answer HTTP 200 with an error body (a provider failed mid-request).
 */
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

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 5 * 60_000;

interface ChatResponse {
  model?: string;
  error?: { code?: number | string; message?: string; metadata?: unknown };
  choices?: {
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: { content?: string | { type?: string; text?: string }[] | null; refusal?: string | null };
    error?: { code?: number | string; message?: string };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export const openrouterProvider: Provider = async (req: ProviderRequest): Promise<ProviderResult> => {
  const doFetch = testHooks().fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    model: req.model,
    max_tokens: req.maxTokens,
    messages: [
      { role: "system", content: req.system },
      {
        role: "user",
        content: req.parts.map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text }
            : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data.toString("base64")}` } },
        ),
      },
    ],
    usage: { include: true },
  });
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

  let res: Response;
  let text: string;
  try {
    res = await doFetch(OPENROUTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${req.apiKey}`, "x-title": "figma-test-platform" },
      body,
      signal,
    });
    text = await res.text();
  } catch (e) {
    if (req.signal?.aborted) throw new ProviderError("cancelled", { kind: "cancelled" });
    const why = timeout.aborted ? `no answer within ${TIMEOUT_MS / 1000}s` : shortText((e as Error)?.message ?? String(e), 160);
    throw new ProviderError(`openrouter not reachable (${why})`, { retryable: true });
  }

  let data: ChatResponse | null = null;
  try {
    data = JSON.parse(text) as ChatResponse;
  } catch {
    /* an HTML error page */
  }
  const usage = usageOf(data, req.model);
  const choice = data?.choices?.[0];
  const bodyError = data?.error ?? choice?.error;
  const status = !res.ok ? res.status : bodyError ? Number(bodyError.code) || 502 : 200;
  if (status !== 200) {
    const detail = shortText(bodyError?.message || text || res.statusText || "error", 300);
    throw new ProviderError(`openrouter ${status}${hint(status)}: ${detail}`, {
      retryable: isRetryableStatus(status),
      status,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      usage: usage ?? undefined,
    });
  }

  const finish = choice?.finish_reason ?? "";
  if (finish === "content_filter" || choice?.message?.refusal) {
    throw new ProviderError(`the model declined the request${choice?.message?.refusal ? ` (${shortText(choice.message.refusal, 120)})` : ""}`, {
      kind: "refused",
      usage: usage ?? undefined,
    });
  }
  const content = choice?.message?.content;
  const answer =
    typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c?.type === "text" ? c.text ?? "" : "")).join("") : "";
  const truncated = finish === "length";
  if (!answer && !truncated) {
    throw new ProviderError(`openrouter returned an empty answer (model ${data?.model ?? req.model})`, { retryable: true, usage: usage ?? undefined });
  }
  const u = usage ?? { model: data?.model ?? req.model, inputTokens: 0, outputTokens: 0, costUsd: null };
  return { ...u, text: answer, truncated };
};

function usageOf(data: ChatResponse | null, asked: string): ProviderUsage | null {
  const u = data?.usage;
  if (!u) return null;
  const model = data?.model || asked;
  const inputTokens = Number(u.prompt_tokens) || 0;
  const outputTokens = Number(u.completion_tokens) || 0;
  const reported = typeof u.cost === "number" && Number.isFinite(u.cost) ? u.cost : null;
  return { model, inputTokens, outputTokens, costUsd: reported ?? costUsd(model, { input: inputTokens, output: outputTokens }) };
}

function hint(status: number): string {
  switch (status) {
    case 401:
      return " (check the API key)";
    case 402:
      return " (no OpenRouter credits left)";
    case 403:
      return " (the request was refused by moderation)";
    case 404:
      return " (unknown model, or no provider for an image input?)";
    case 413:
      return " (request too large: smaller image or less text)";
    default:
      return "";
  }
}
