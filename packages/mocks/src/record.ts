import type { BrowserContext, Response } from "playwright";
import { graphqlOf, isApiRequest, parseJson } from "./api";
import { canonical } from "./json";
import type { RecordedCall, Recorder } from "./types";

/** a bigger body is not kept (a download, a dump): a mock is data for one screen */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const BODY_TIMEOUT = 15_000;
const BINARY = /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|x-protobuf|protobuf|grpc|wasm)/i;

/** Starts recording the API calls of the pages of a context (include globs, or fetch/XHR to siteHost when empty). */
export async function startRecording(context: BrowserContext, opts: { include: string[]; siteHost: string }): Promise<Recorder> {
  const calls = new Map<string, RecordedCall>();
  const pending = new Set<Promise<void>>();

  const onResponse = (response: Response) => {
    const job = record(response, opts)
      .then((call) => {
        if (!call) return;
        // one call per distinct request; a later answer to the same request replaces the earlier one
        const key = canonical([call.method, call.host, call.path, call.query, call.operationName, call.variables]);
        calls.delete(key);
        calls.set(key, call);
      })
      .catch(() => undefined)
      .finally(() => pending.delete(job));
    pending.add(job);
  };
  context.on("response", onResponse);

  let stopped = false;
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        context.off("response", onResponse);
      }
      // the bodies still being read
      while (pending.size) await Promise.allSettled([...pending]);
      return [...calls.values()];
    },
  };
}

async function record(response: Response, opts: { include: string[]; siteHost: string }): Promise<RecordedCall | null> {
  const request = response.request();
  if (!isApiRequest(request.url(), request.resourceType(), opts)) return null;
  const method = request.method().toUpperCase();
  if (method === "OPTIONS") return null;
  const status = response.status();
  if ((status >= 300 && status < 400) || request.redirectedTo()) return null;

  // headers are read for the content type and the size only; none is kept
  const headers = response.headers();
  const contentType = (headers["content-type"] ?? "").trim();
  if (BINARY.test(contentType)) return null;
  const declared = Number(headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  let raw: Buffer;
  try {
    raw = await withTimeout(response.body(), BODY_TIMEOUT);
  } catch {
    return null; // the page went away, or no body (a redirect)
  }
  if (raw.length > MAX_BODY_BYTES) return null;
  const text = raw.toString("utf8");
  const looksJson = /json/i.test(contentType) || /^\s*[[{]/.test(text);
  const parsed = looksJson ? parseJson(text) : undefined;
  const body: unknown = parsed !== undefined ? parsed : text;

  const url = new URL(request.url());
  const gql = graphqlOf(method, url, request.postData());
  return {
    method,
    url: url.href,
    host: url.host,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    operationName: gql?.operationName ?? null,
    variables: gql ? gql.variables : null,
    status,
    contentType: contentType || (parsed !== undefined ? "application/json" : "text/plain"),
    body,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
