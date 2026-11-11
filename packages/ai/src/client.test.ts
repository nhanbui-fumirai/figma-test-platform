import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiError, completeJson, DEFAULT_MODELS, MAX_ATTEMPTS, MAX_IMAGE_BYTES } from "./client";
import { extractJson } from "./json";
import { costUsd } from "./pricing";
import { setTestHooks } from "./transport";
import type { AiConfig, AiUsage } from "./types";

const KEY = "sk-test-SECRET-KEY-0123456789";
const OR: AiConfig = { provider: "openrouter", apiKey: KEY, model: "google/gemini-2.5-flash" };
const AN: AiConfig = { provider: "anthropic", apiKey: KEY, model: "claude-opus-5-5" };
const Answer = z.object({ answer: z.number() });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// ---------------------------------------------------------------- fakes (no network)

type Reply = Response | Error;

function orReply(content: string | null, opts: { status?: number; cost?: number; finish?: string; headers?: Record<string, string>; raw?: unknown } = {}): Response {
  const body = opts.raw ?? {
    model: OR.model,
    choices: [{ finish_reason: opts.finish ?? "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 1200, completion_tokens: 300, cost: opts.cost ?? 0.0012 },
  };
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers: { "content-type": "application/json", ...opts.headers } });
}

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const r = replies.shift();
    if (!r) throw new Error("test: no more fake replies");
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn: fn as typeof fetch, calls };
}

function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, iterations: null },
    ...extra,
  };
}

function fakeAnthropic(replies: (object | Error)[]) {
  const calls: any[] = [];
  const keys: string[] = [];
  const factory = (apiKey: string) => {
    keys.push(apiKey);
    return {
      beta: {
        messages: {
          stream(params: any) {
            calls.push(params);
            return {
              finalMessage: async () => {
                const r = replies.shift();
                if (!r) throw new Error("test: no more fake replies");
                if (r instanceof Error) throw r;
                return r as any;
              },
            };
          },
        },
      },
    };
  };
  return { factory, calls, keys };
}

const overloaded = (retryAfter?: string) =>
  APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers(retryAfter ? { "retry-after": retryAfter } : {}));

let sleeps: number[];
let usages: AiUsage[];
const onUsage = (u: AiUsage) => {
  usages.push(u);
};

beforeEach(() => {
  sleeps = [];
  usages = [];
  // any real network call fails the test
  vi.stubGlobal("fetch", () => {
    throw new Error("test: real network call");
  });
});
afterEach(() => {
  setTestHooks({});
  vi.unstubAllGlobals();
});

function useOpenRouter(replies: Reply[]) {
  const f = fakeFetch(replies);
  setTestHooks({ fetch: f.fn, sleep: async (ms) => void sleeps.push(ms) });
  return f;
}

function useAnthropic(replies: (object | Error)[]) {
  const a = fakeAnthropic(replies);
  setTestHooks({ anthropic: a.factory, sleep: async (ms) => void sleeps.push(ms) });
  return a;
}

async function caught(p: Promise<unknown>): Promise<AiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AiError);
    return e as AiError;
  }
  throw new Error("test: expected an AiError");
}

// ---------------------------------------------------------------- JSON extraction

describe("extractJson", () => {
  it("reads a ```json fenced block among prose", () => {
    const r = extractJson('Here you go:\n```json\n{"answer": 1}\n```\nThanks');
    expect(r).toEqual({ ok: true, value: { answer: 1 } });
  });
  it("reads an unlabeled fence, and prefers a json-labeled one", () => {
    expect(extractJson("```\n[1,2]\n```")).toEqual({ ok: true, value: [1, 2] });
    expect(extractJson('```ts\nconst a = 1\n```\n```json\n{"a":2}\n```')).toEqual({ ok: true, value: { a: 2 } });
  });
  it("reads raw JSON, and JSON inside prose", () => {
    expect(extractJson('  {"answer": 3}  ')).toEqual({ ok: true, value: { answer: 3 } });
    expect(extractJson('The result is {"a": "x}y", "b": [1, {"c": 2}]} as asked.')).toEqual({ ok: true, value: { a: "x}y", b: [1, { c: 2 }] } });
  });
  it("says why there is no JSON", () => {
    expect(extractJson("")).toMatchObject({ ok: false, reason: "the answer is empty" });
    expect(extractJson("I cannot do that")).toMatchObject({ ok: false, reason: "no JSON in the answer" });
    const cut = extractJson('```json\n{"steps": [{"action": "click"');
    expect(cut.ok).toBe(false);
    expect(!cut.ok && cut.reason).toMatch(/incomplete/);
  });
});

// ---------------------------------------------------------------- completeJson

describe("completeJson (openrouter)", () => {
  it("sends system, text and image, asks for usage, validates the answer and reports usage with the provider cost", async () => {
    const f = useOpenRouter([orReply('```json\n{"answer": 42}\n```', { cost: 0.0042 })]);
    const value = await completeJson(
      OR,
      { system: "Be exact.", content: [{ type: "image", png: PNG }, { type: "text", text: "What is it?" }], schema: Answer, purpose: "test" },
      onUsage,
    );
    expect(value).toEqual({ answer: 42 });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.body.model).toBe("google/gemini-2.5-flash");
    expect(call.body.usage).toEqual({ include: true });
    expect(call.body.messages[0].role).toBe("system");
    expect(call.body.messages[0].content).toMatch(/^Be exact\.[\s\S]*JSON value only/);
    expect(call.body.messages[1].content[0]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } });
    expect(call.body.messages[1].content[1]).toEqual({ type: "text", text: "What is it?" });
    expect(usages).toEqual([{ model: "google/gemini-2.5-flash", inputTokens: 1200, outputTokens: 300, costUsd: 0.0042, ok: true, purpose: "test" }]);
  });

  it("repairs an invalid answer: succeeds on the 2nd try, quoting the bad answer and the reason", async () => {
    const f = useOpenRouter([orReply("Sure! The answer is forty-two."), orReply('{"answer": 42}')]);
    const value = await completeJson(OR, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage);
    expect(value).toEqual({ answer: 42 });
    expect(f.calls).toHaveLength(2);
    const repair = f.calls[1]!.body.messages[1].content.at(-1).text as string;
    expect(repair).toContain("could not be used");
    expect(repair).toContain("no JSON in the answer");
    expect(repair).toContain("Sure! The answer is forty-two.");
    expect(f.calls[1]!.body.messages[1].content[0]).toEqual({ type: "text", text: "q" });
    expect(usages.map((u) => u.ok)).toEqual([true, true]);
  });

  it("fails with a short reason after 2 repairs (3 calls)", async () => {
    const f = useOpenRouter([orReply('{"answer": "x"}'), orReply('{"answer": "y"}'), orReply('{"answer": "z"}')]);
    const e = await caught(completeJson(OR, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage));
    expect(e.code).toBe("invalid_answer");
    expect(e.message).toMatch(/^test: no valid answer after 2 repairs \(the JSON does not match the expected shape: answer: /);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]!.body.messages[1].content.at(-1).text).toContain('{"answer": "y"}');
    expect(usages).toHaveLength(3);
  });

  it("tells a cut-off answer to be shorter", async () => {
    const f = useOpenRouter([orReply('{"answer": ', { finish: "length" }), orReply('{"answer": 1}')]);
    await completeJson(OR, { system: "s", content: "q", schema: Answer, purpose: "test" });
    expect(f.calls[1]!.body.messages[1].content.at(-1).text).toMatch(/cut off at the output limit/);
  });

  it("retries 429 (Retry-After), 503, a 200 with an error body and a network error; one usage report per HTTP call", async () => {
    // 4 attempts max: the 4th one succeeds
    const f = useOpenRouter([
      orReply(null, { status: 429, headers: { "retry-after": "3" }, raw: { error: { code: 429, message: "slow down" } } }),
      orReply(null, { raw: { error: { code: 502, message: "upstream provider failed" } } }),
      new TypeError("fetch failed"),
      orReply('{"answer": 7}'),
    ]);
    const value = await completeJson(OR, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage);
    expect(value).toEqual({ answer: 7 });
    expect(f.calls).toHaveLength(4);
    expect(sleeps[0]).toBe(3000);
    expect(sleeps).toHaveLength(3);
    expect(usages.map((u) => u.ok)).toEqual([false, false, false, true]);
  });

  it(`gives up after ${MAX_ATTEMPTS} transient failures`, async () => {
    const f = useOpenRouter(Array.from({ length: MAX_ATTEMPTS }, () => orReply(null, { status: 503, raw: { error: { message: "unavailable" } } })));
    const e = await caught(completeJson(OR, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage));
    expect(e.code).toBe("provider");
    expect(e.status).toBe(503);
    expect(e.message).toBe(`test: openrouter 503: unavailable (after ${MAX_ATTEMPTS} attempts)`);
    expect(f.calls).toHaveLength(MAX_ATTEMPTS);
    expect(usages.every((u) => !u.ok)).toBe(true);
  });

  it("does not retry a 400, and never shows the key in the error", async () => {
    const f = useOpenRouter([orReply(null, { status: 401, raw: { error: { code: 401, message: `Invalid API key ${KEY} (Bearer ${KEY})` } } })]);
    const e = await caught(completeJson(OR, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage));
    expect(f.calls).toHaveLength(1);
    expect(e.status).toBe(401);
    expect(e.message).toContain("check the API key");
    for (const s of [e.message, String(e), e.stack ?? "", JSON.stringify(e)]) expect(s).not.toContain(KEY);
    expect(JSON.stringify(usages)).not.toContain(KEY);
  });

  it("leaves out an image over the size cap, with a note", async () => {
    const f = useOpenRouter([orReply('{"answer": 1}')]);
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 7);
    await completeJson(OR, { system: "s", content: [{ type: "image", png: big }, { type: "text", text: "q" }], schema: Answer, purpose: "test" });
    const content = f.calls[0]!.body.messages[1].content;
    expect(content.some((c: any) => c.type === "image_url")).toBe(false);
    expect(content[0].text).toMatch(/image was left out: 3\.5 MB is over the 3\.5 MB limit/);
  });

  it("stops at once when the signal is aborted, and rejects a missing key", async () => {
    const f = useOpenRouter([]);
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await caught(completeJson(OR, { system: "s", content: "q", schema: Answer, purpose: "t", signal: ctrl.signal }))).code).toBe("cancelled");
    expect((await caught(completeJson({ ...OR, apiKey: " " }, { system: "s", content: "q", schema: Answer, purpose: "t" }))).code).toBe("config");
    expect(f.calls).toHaveLength(0);
  });
});

describe("completeJson (anthropic)", () => {
  it("streams one request with image block, fallback chain and effort; usage priced from the table", async () => {
    const a = useAnthropic([message('{"answer": 5}', { usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, iterations: null } })]);
    const value = await completeJson(AN, { system: "Be exact.", content: [{ type: "image", png: PNG }, { type: "text", text: "q" }], schema: Answer, purpose: "test" }, onUsage);
    expect(value).toEqual({ answer: 5 });
    expect(a.keys).toEqual([KEY]);
    const p = a.calls[0];
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(16_000);
    expect(p.system).toMatch(/^Be exact\./);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toContain("server-side-fallback-2026-07-01");
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.temperature).toBeUndefined();
    // 1000 in + 200 cache reads at $4/M (reads 0.1x) + 500 out at $20/M
    expect(usages).toEqual([{ model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 500, costUsd: costUsd("claude-opus-5-5", { input: 1000, output: 500, cacheRead: 200 }), ok: true, purpose: "test" }]);
    expect(usages[0]!.costUsd).toBeCloseTo(0.004 + 0.00008 + 0.01, 8);
  });

  it("retries an overloaded (529) answer after Retry-After, and a connection error", async () => {
    const a = useAnthropic([overloaded("2"), new APIConnectionError({ message: "socket hang up" }), message('{"answer": 9}')]);
    const value = await completeJson(AN, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage);
    expect(value).toEqual({ answer: 9 });
    expect(a.calls).toHaveLength(3);
    expect(sleeps[0]).toBe(2000);
    expect(usages.map((u) => u.ok)).toEqual([false, false, true]);
  });

  it("retries an error event in the middle of the stream (no status)", async () => {
    const midStream = new APIError(undefined, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, undefined);
    const a = useAnthropic([midStream, message('{"answer": 1}')]);
    await completeJson(AN, { system: "s", content: "q", schema: Answer, purpose: "test" });
    expect(a.calls).toHaveLength(2);
  });

  it("does not retry 401 and masks the key the error echoes", async () => {
    const err = APIError.generate(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }, undefined, new Headers());
    const a = useAnthropic([err]);
    const e = await caught(completeJson(AN, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage));
    expect(a.calls).toHaveLength(1);
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/^test: anthropic 401 \(check the API key\): invalid x-api-key \*\*\*$/);
    for (const s of [e.message, String(e), e.stack ?? ""]) expect(s).not.toContain(KEY);
  });

  it("repairs through the same request shape (one user turn, the bad answer quoted)", async () => {
    const a = useAnthropic([message("```json\n{\"answer\": \"no\"}\n```"), message('{"answer": 3}')]);
    expect(await completeJson(AN, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage)).toEqual({ answer: 3 });
    expect(a.calls[1].messages).toHaveLength(1);
    expect(a.calls[1].messages[0].content.at(-1).text).toContain('{"answer": "no"}');
    expect(usages).toHaveLength(2);
  });

  it("a refusal is an AiError 'refused', not retried", async () => {
    const a = useAnthropic([message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } })]);
    const e = await caught(completeJson(AN, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage));
    expect(e.code).toBe("refused");
    expect(e.message).toBe("test: the model declined the request (cyber)");
    expect(a.calls).toHaveLength(1);
    expect(usages).toHaveLength(1);
    expect(usages[0]!.ok).toBe(false);
  });

  it("prices each model of a fallback chain", async () => {
    useAnthropic([
      message('{"answer": 1}', {
        model: "claude-opus-5",
        usage: {
          input_tokens: 2000,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            { type: "fallback_message", model: "claude-opus-5", input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          ],
        },
      }),
    ]);
    await completeJson(AN, { system: "s", content: "q", schema: Answer, purpose: "test" }, onUsage);
    expect(usages[0]!.model).toBe("claude-opus-5");
    expect(usages[0]!.costUsd).toBeCloseTo((1000 * 4 + 50 * 20 + 1000 * 5 + 50 * 25) / 1e6, 8);
  });
});

describe("models and prices", () => {
  it("has default models for both providers", () => {
    expect(DEFAULT_MODELS.anthropic).toBe("claude-opus-5-5");
    expect(DEFAULT_MODELS.openrouter).toBe("anthropic/claude-opus-5.5");
  });
  it("maps OpenRouter ids and dated ids to the table, unknown models to null", () => {
    expect(costUsd("anthropic/claude-opus-5.5", { input: 1_000_000, output: 0 })).toBe(4);
    expect(costUsd("claude-haiku-4-5-20251001", { input: 0, output: 1_000_000 })).toBe(5);
    expect(costUsd("some/unknown-model", { input: 1, output: 1 })).toBeNull();
  });
});
