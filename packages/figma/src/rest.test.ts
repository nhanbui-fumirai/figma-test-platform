import { describe, expect, it } from "vitest";
import { listDesign } from "./frames";
import { parseFigmaUrl, readFigmaFile } from "./rest";

describe("parseFigmaUrl", () => {
  it("reads the file key and the node id of a design link (node-id=12-34)", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123xyz0/My-File?node-id=12-34&t=abc-1")).toEqual({ fileKey: "AbC123xyz0", nodeId: "12:34" });
  });
  it("reads a file link with an encoded node id (12%3A34)", () => {
    expect(parseFigmaUrl("https://www.figma.com/file/KEY1234567/Name?type=design&node-id=12%3A34")).toEqual({ fileKey: "KEY1234567", nodeId: "12:34" });
  });
  it("reads a prototype link", () => {
    expect(parseFigmaUrl("https://www.figma.com/proto/KEY1234567/Name?node-id=1-2&starting-point-node-id=1%3A2&scaling=scale-down")).toEqual({ fileKey: "KEY1234567", nodeId: "1:2" });
  });
  it("has no node id when the link has none", () => {
    expect(parseFigmaUrl("https://figma.com/design/KEY1234567/Name")).toEqual({ fileKey: "KEY1234567", nodeId: null });
    expect(parseFigmaUrl("www.figma.com/file/KEY1234567")).toEqual({ fileKey: "KEY1234567", nodeId: null });
  });
  it("takes the branch key of a branch link", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/MAINKEY123/branch/BRANCHKEY9/Name?node-id=5-6")).toEqual({ fileKey: "BRANCHKEY9", nodeId: "5:6" });
  });
  it("accepts a bare file key", () => {
    expect(parseFigmaUrl("  AbC123xyz0  ")).toEqual({ fileKey: "AbC123xyz0", nodeId: null });
  });
  it("rejects other links", () => {
    expect(() => parseFigmaUrl("https://example.com/design/KEY1234567/x")).toThrow(/Not a Figma link/);
    expect(() => parseFigmaUrl("https://www.figma.com/community/plugin/123")).toThrow(/no file key/);
  });
});

// ---------------------------------------------------------------- fake Figma API

const TOKEN = "figd_SECRET-token-value-123";
const KEY = "FILEKEY123";
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const shallowFrame = (id: string, name: string, x: number) => ({ id, name, type: "FRAME", absoluteBoundingBox: box(x, 0, 375, 700) });
const fullFrame = (id: string, name: string, x: number) => ({
  ...shallowFrame(id, name, x),
  clipsContent: true,
  fills: [{ type: "IMAGE", imageRef: "ref1", scaleMode: "FILL" }],
  children: [{ id: `${id}-t`, name: "Title", type: "TEXT", characters: name, style: { fontFamily: "Inter", fontSize: 16 }, absoluteBoundingBox: box(x + 10, 10, 100, 20) }],
});

type Call = { url: string; token: string | null };
function fakeFigma(opts: { failFirst?: { status: number; retryAfter?: string; body?: string } } = {}) {
  const calls: Call[] = [];
  let failed = false;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, token: headers.get("x-figma-token") });
    if (opts.failFirst && !failed) {
      failed = true;
      const h: Record<string, string> = opts.failFirst.retryAfter !== undefined ? { "retry-after": opts.failFirst.retryAfter } : {};
      return new Response(opts.failFirst.body ?? "slow down", { status: opts.failFirst.status, headers: h });
    }
    const u = new URL(url);
    if (u.hostname === "s3.example") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (u.pathname === `/v1/files/${KEY}` && u.searchParams.get("depth") === "2") {
      return json({
        name: "Shop", version: "42", lastModified: "2026-01-01T00:00:00Z",
        document: { id: "0:0", type: "DOCUMENT", children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children: [shallowFrame("1:1", "Home", 0), { id: "5:0", name: "Checkout", type: "SECTION", absoluteBoundingBox: box(1000, 0, 2000, 900) }] }] },
        components: {},
      });
    }
    if (u.pathname === `/v1/files/${KEY}/nodes`) {
      const ids = (u.searchParams.get("ids") ?? "").split(",");
      const nodes: Record<string, unknown> = {};
      for (const id of ids) {
        if (id === "5:0" && u.searchParams.get("depth") === "1") {
          nodes[id] = { document: { id: "5:0", name: "Checkout", type: "SECTION", children: [shallowFrame("2:2", "Cart", 1100)] } };
        } else if (id === "1:1" && u.searchParams.get("geometry") === "paths") {
          nodes[id] = { document: fullFrame("1:1", "Home", 0), components: { "9:9": { key: "k", name: "Button" } } };
        } else if (id === "2:2" && u.searchParams.get("geometry") === "paths") {
          nodes[id] = { document: fullFrame("2:2", "Cart", 1100) };
        } else nodes[id] = null;
      }
      return json({ name: "Shop", version: "42", nodes });
    }
    if (u.pathname === `/v1/files/${KEY}/images`) return json({ meta: { images: { ref1: "https://s3.example/img1" } } });
    return json({ status: 404, err: "Not found" }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("readFigmaFile", () => {
  it("reads the pages, the sections and the frames (429 retried), sends the token to the API only", async () => {
    const fake = fakeFigma({ failFirst: { status: 429, retryAfter: "0" } });
    const logs: string[] = [];
    const doc = await readFigmaFile(KEY, { token: TOKEN, fetch: fake.fetchImpl, log: (m) => logs.push(m) });
    expect(doc).toMatchObject({ source: "rest", fileName: "Shop", fileKey: KEY, version: "42" });
    expect(doc.components?.["9:9"]?.name).toBe("Button");
    const { groups, frames } = listDesign(doc);
    expect(groups.map((g) => [g.kind, g.nodeId, g.parentNodeId])).toEqual([["page", "0:1", null], ["section", "5:0", "0:1"]]);
    expect(frames.map((f) => [f.nodeId, f.groupNodeId, f.name])).toEqual([["1:1", "0:1", "Home"], ["2:2", "5:0", "Cart"]]);
    expect(frames[0]!.node.children?.[0]?.type).toBe("TEXT"); // full frames, not the shallow ones
    // the first call got a 429 and was made again
    expect(fake.calls[0]!.url).toBe(fake.calls[1]!.url);
    expect(fake.calls.some((c) => c.url.includes("geometry=paths"))).toBe(true);
    // images: asked when needed, downloaded without the token
    expect(fake.calls.some((c) => c.url.includes("/images"))).toBe(false);
    expect(await doc.image("ref1")).toEqual(Buffer.from([1, 2, 3]));
    expect(await doc.image("nope")).toBeNull();
    const download = fake.calls.find((c) => c.url.startsWith("https://s3.example"))!;
    expect(download.token).toBeNull();
    expect(fake.calls.filter((c) => c.url.startsWith("https://api.figma.com")).every((c) => c.token === TOKEN)).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.some((l) => l.includes("429"))).toBe(true);
  });

  it("reads only the node asked for (a frame in a section) and the path to it", async () => {
    const fake = fakeFigma();
    const doc = await readFigmaFile(KEY, { token: TOKEN, fetch: fake.fetchImpl, nodeId: "2-2" });
    const { groups, frames } = listDesign(doc);
    expect(groups.map((g) => g.nodeId)).toEqual(["0:1", "5:0"]);
    expect(frames.map((f) => f.nodeId)).toEqual(["2:2"]);
    const nodesCalls = fake.calls.filter((c) => c.url.includes("geometry=paths"));
    expect(nodesCalls).toHaveLength(1);
    expect(decodeURIComponent(nodesCalls[0]!.url)).toContain("ids=2:2&");
  });

  it("never puts the token in an error", async () => {
    const fake = fakeFigma({ failFirst: { status: 403, body: `Invalid token ${TOKEN}` } });
    const err = await readFigmaFile(KEY, { token: TOKEN, fetch: fake.fetchImpl }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(String((err as Error).stack)).not.toContain(TOKEN);
  });

  it("fails at once on a rate limit that asks to wait for hours", async () => {
    const fake = fakeFigma({ failFirst: { status: 429, retryAfter: "3600" } });
    const t = Date.now();
    await expect(readFigmaFile(KEY, { token: TOKEN, fetch: fake.fetchImpl })).rejects.toThrow(/retry after 3600 s/);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("stops when the signal aborts", async () => {
    const fake = fakeFigma();
    const ac = new AbortController();
    ac.abort();
    await expect(readFigmaFile(KEY, { token: TOKEN, fetch: fake.fetchImpl, signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("says which node is not a screen", async () => {
    const fake = fakeFigma();
    await expect(readFigmaFile(KEY, { token: TOKEN, fetch: fake.fetchImpl, nodeId: "77:77" })).rejects.toThrow(/77:77/);
  });
});
