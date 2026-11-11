/**
 * Figma REST API → the same REST-shaped document as a .fig gives.
 *   1. GET /v1/files/:key?depth=2                      pages and what is on them (frames, sections: no content)
 *   2. GET /v1/files/:key/nodes?ids=<sections>&depth=1  what is in the sections (nested ones: once per level)
 *   3. GET /v1/files/:key/nodes?ids=…&geometry=paths    the frames with their content, in batches
 *   4. GET /v1/files/:key/images                        image fill URLs, asked when an image is first needed; the
 *                                                       images are downloaded then (small cache)
 * With opts.nodeId (a page, a section or a frame) only that node and what is in it are read.
 * 429 and 5xx are retried, waiting what Retry-After says (or a growing delay); a wait of more than 2 minutes (Figma's
 * monthly limits of low-tier seats can ask for hours) fails at once with that wait in the message. The token goes in
 * the X-Figma-Token header only and never into a message or a log line.
 */
import type { DesignDocument, RestOptions } from "./types";
import { type AnyNode, abortError, childrenOf, sleep } from "./util";

const API = "https://api.figma.com";
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);
const BATCH = 20;
const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 120_000;
const IMAGE_CACHE = 32;

/** file key and node id ("12:34") of a figma.com link (file / design / proto, node-id=12-34 or 12%3A34) */
export function parseFigmaUrl(url: string): { fileKey: string; nodeId: string | null } {
  const text = url.trim();
  if (/^[A-Za-z0-9]{10,64}$/.test(text)) return { fileKey: text, nodeId: null };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`Not a Figma link: ${text.slice(0, 200)}`);
  }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) throw new Error(`Not a Figma link: ${u.hostname}`);
  // /file/<key>/<name>, /design/<key>/<name>, /proto/<key>/..., and a branch: /design/<key>/branch/<branchKey>/<name>
  const m = /^\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/.exec(u.pathname);
  if (!m?.[1]) throw new Error(`Not a Figma file link (no file key): ${u.pathname.slice(0, 200)}`);
  const node = u.searchParams.get("node-id") ?? u.searchParams.get("starting-point-node-id");
  const nodeId = node ? node.trim().replace(/-/g, ":") : null;
  return { fileKey: m[2] ?? m[1], nodeId: nodeId || null };
}

/** HTTP error of the Figma API (status kept for the caller). */
export class FigmaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "FigmaApiError";
  }
}

type Json = AnyNode;

/** GET of the Figma API with retries; messages never contain the token. */
class Api {
  private readonly fetch: typeof fetch;
  constructor(private readonly token: string, private readonly opts: RestOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /** the message without the token in it (a body or an error could echo it) */
  scrub(s: string): string {
    return this.token ? s.split(this.token).join("***") : s;
  }

  log(message: string) {
    this.opts.log?.(this.scrub(message));
  }

  async get(pathname: string): Promise<Json> {
    const { signal } = this.opts;
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      let res: Response;
      try {
        res = await this.fetch(API + pathname, { headers: { "X-Figma-Token": this.token }, signal });
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        if (attempt >= MAX_ATTEMPTS) throw new Error(this.scrub(`Figma API: GET ${pathname} failed: ${(e as Error).message}`));
        const wait = backoff(attempt);
        this.log(`Figma API: GET ${pathname} failed (${this.scrub((e as Error).message)}), retrying in ${Math.round(wait / 1000)} s`);
        await sleep(wait, signal);
        continue;
      }
      if (res.ok) return (await res.json()) as Json;
      const retryable = res.status === 429 || res.status >= 500;
      const body = this.scrub((await res.text().catch(() => "")).slice(0, 300));
      if (retryable && attempt < MAX_ATTEMPTS) {
        const after = retryAfterMs(res.headers.get("retry-after"));
        const wait = after ?? backoff(attempt);
        if (wait > MAX_WAIT_MS) {
          throw new FigmaApiError(`Figma API rate limit (${res.status}) for GET ${pathname}: retry after ${Math.round(wait / 1000)} s`
            + `${res.headers.get("x-figma-plan-tier") ? `, plan tier ${res.headers.get("x-figma-plan-tier")}` : ""}`, res.status);
        }
        this.log(`Figma API: ${res.status} for GET ${pathname}, retrying in ${Math.round(wait / 1000)} s`);
        await sleep(wait, signal);
        continue;
      }
      const hint = res.status === 403 ? " (token invalid or without access to the file)" : res.status === 404 ? " (file or node not found)" : "";
      throw new FigmaApiError(`Figma API ${res.status}${hint} for GET ${pathname}${body ? `: ${body}` : ""}`, res.status);
    }
  }

  /** bytes of a URL outside the API (image downloads): no token sent */
  async download(url: string): Promise<Buffer | null> {
    const { signal } = this.opts;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.fetch(url, { signal });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt), signal);
          continue;
        }
        return null;
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        if (attempt >= 3) return null;
        await sleep(backoff(attempt), signal);
      }
    }
  }
}

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1));

function retryAfterMs(header: string | null): number | null {
  if (header == null || header.trim() === "") return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Reads a file (or one node of it) with the REST API: depth-limited file, then batched /nodes, 429 retry. */
export async function readFigmaFile(fileKey: string, opts: RestOptions): Promise<DesignDocument> {
  if (!opts?.token) throw new Error("Figma API: a personal access token is required");
  const key = fileKey.trim();
  if (!/^[A-Za-z0-9]+$/.test(key)) throw new Error(`Figma API: not a file key: ${key.slice(0, 80)}`);
  const api = new Api(opts.token, opts);
  const nodesPath = (ids: string[], extra: string) => `/v1/files/${key}/nodes?ids=${encodeURIComponent(ids.join(","))}${extra}`;
  const components: NonNullable<DesignDocument["components"]> = {};
  const componentSets: NonNullable<DesignDocument["componentSets"]> = {};
  /** components of a response: at its root (GET file), or of each node (GET nodes) */
  const keep = (r: Json) => {
    for (const part of [r, ...Object.values<Json | null>(r.nodes ?? {})]) {
      if (!part) continue;
      Object.assign(components, part.components ?? {});
      Object.assign(componentSets, part.componentSets ?? {});
    }
  };

  api.log(`Figma API: GET file ${key} (pages and their top-level nodes)`);
  const file = await api.get(`/v1/files/${key}?depth=2`);
  keep(file);
  const pages: Json[] = childrenOf(file.document ?? {}).filter((p) => p.type === "CANVAS");

  // what is in the sections, level by level (a section of depth=2 comes without its children)
  const sections = new Map<string, Json>();
  const collect = (list: Json[]) => {
    const out: Json[] = [];
    for (const n of list) {
      if (n.type === "SECTION" && !sections.has(n.id)) {
        sections.set(n.id, n);
        out.push(n);
      }
    }
    return out;
  };
  let pending = pages.flatMap((p) => collect(childrenOf(p)));
  const want = opts.nodeId ? String(opts.nodeId).replace(/-/g, ":") : null;
  const findPath = (): Json[] | null => {
    if (!want) return null;
    const search = (n: Json, trail: Json[]): Json[] | null => {
      if (n.id === want) return [...trail, n];
      if (n.type !== "CANVAS" && n.type !== "SECTION") return null;
      for (const c of childrenOf(n)) {
        const p = search(c, [...trail, n]);
        if (p) return p;
      }
      return null;
    };
    for (const p of pages) {
      const r = search(p, []);
      if (r) return r;
    }
    return null;
  };
  while (pending.length) {
    // with a node asked for: stop as soon as it is found, unless it is a section (its sections are read below)
    const path = findPath();
    if (path) {
      const target = path[path.length - 1]!;
      if (target.type !== "SECTION" && target.type !== "CANVAS") break;
      pending = pending.filter((s) => inside(s, target));
      if (!pending.length) break;
    }
    const next: Json[] = [];
    for (let i = 0; i < pending.length; i += 50) {
      const ids = pending.slice(i, i + 50).map((s) => s.id as string);
      api.log(`Figma API: GET ${ids.length} section(s)`);
      const r = await api.get(nodesPath(ids, "&depth=1"));
      keep(r);
      for (const id of ids) {
        const doc = r.nodes?.[id]?.document;
        const s = sections.get(id);
        if (doc && s) {
          s.children = childrenOf(doc);
          next.push(...collect(s.children));
        }
      }
    }
    pending = next;
  }

  // the pages to return: all, or the path down to the node asked for
  let outPages = pages;
  if (want) {
    const path = findPath();
    if (!path) throw new Error(`Figma API: node ${want} is not a page, a section or a frame of a page or section of file ${key}`);
    const [page, ...rest] = path;
    const trim = (n: Json, below: Json[]): Json => {
      const [next, ...more] = below;
      if (!next) return n;
      return { ...n, children: [trim(next, more)] };
    };
    outPages = [trim(page!, rest)];
  }

  // the frames, with their content and vector paths
  const frames: Json[] = [];
  const gather = (n: Json) => {
    for (const c of childrenOf(n)) {
      if (FRAME_TYPES.has(c.type)) frames.push(c);
      else if (c.type === "SECTION") gather(c);
    }
  };
  for (const p of outPages) {
    const last = want ? findIn(p, want) : null;
    if (last && FRAME_TYPES.has(last.type)) frames.push(last);
    else gather(last ?? p);
  }
  const full = new Map<string, Json>();
  const fetchBatch = async (ids: string[]): Promise<void> => {
    try {
      api.log(`Figma API: GET ${ids.length} frame(s) with their content`);
      const r = await api.get(nodesPath(ids, "&geometry=paths"));
      keep(r);
      for (const id of ids) {
        const doc = r.nodes?.[id]?.document;
        if (doc) full.set(id, doc);
        else api.log(`Figma API: node ${id} not found`);
      }
    } catch (e) {
      // a batch too large for Figma to answer: half of it at a time
      const status = (e as FigmaApiError).status ?? 0;
      if (ids.length > 1 && (status >= 500 || status === 413 || (status === 400 && /too large|timeout/i.test((e as Error).message)))) {
        const half = Math.ceil(ids.length / 2);
        await fetchBatch(ids.slice(0, half));
        await fetchBatch(ids.slice(half));
        return;
      }
      throw e;
    }
  };
  const ids = [...new Set(frames.map((f) => f.id as string))];
  for (let i = 0; i < ids.length; i += BATCH) await fetchBatch(ids.slice(i, i + BATCH));
  const replace = (n: Json): Json => {
    const doc = full.get(n.id);
    if (doc && FRAME_TYPES.has(n.type)) return doc;
    if (n.type === "CANVAS" || n.type === "SECTION") return { ...n, children: childrenOf(n).map(replace) };
    return n;
  };
  outPages = outPages.map(replace);
  api.log(`Figma API: ${full.size} frame(s) read from "${file.name ?? key}"`);

  // image fills: the URLs are asked once, when the first image is needed; the bytes are kept for the last few
  let urls: Promise<Record<string, string>> | null = null;
  const cache = new Map<string, Promise<Buffer | null>>();
  const imageUrls = () => {
    urls ??= api.get(`/v1/files/${key}/images`).then((r) => (r.meta?.images ?? r.images ?? {}) as Record<string, string>).catch((e) => {
      urls = null;
      throw e;
    });
    return urls;
  };

  return {
    source: "rest",
    fileName: String(file.name ?? key),
    fileKey: key,
    version: String(file.version ?? ""),
    pages: outPages as DesignDocument["pages"],
    components,
    componentSets,
    image(ref: string) {
      const hit = cache.get(ref);
      if (hit) {
        cache.delete(ref);
        cache.set(ref, hit);
        return hit;
      }
      const p = imageUrls().then((map) => (map[ref] ? api.download(map[ref]!) : null));
      cache.set(ref, p);
      p.catch(() => cache.delete(ref));
      while (cache.size > IMAGE_CACHE) cache.delete(cache.keys().next().value!);
      return p;
    },
  };
}

function inside(n: Json, target: Json): boolean {
  if (n === target) return true;
  return childrenOf(target).some((c) => c === n || (c.type === "SECTION" && inside(n, c)));
}

function findIn(n: Json, id: string): Json | null {
  if (n.id === id) return n;
  for (const c of childrenOf(n)) {
    const r = findIn(c, id);
    if (r) return r;
  }
  return null;
}
