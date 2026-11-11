import { describe, expect, it } from "vitest";
import { MAX_HEIGHT } from "./area";
import { draftName, listDesign } from "./frames";
import { extractSpec } from "./spec";
import type { DesignDocument, FigmaNode } from "./types";

// ---------------------------------------------------------------- hand-made REST-shaped nodes

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
let seq = 0;
const node = (type: string, name: string, b: ReturnType<typeof box>, extra: Record<string, unknown> = {}): FigmaNode =>
  ({ id: `${++seq}:1`, name, type, absoluteBoundingBox: b, ...extra }) as FigmaNode;
const rect = (name: string, b: ReturnType<typeof box>, extra: Record<string, unknown> = {}) =>
  node("RECTANGLE", name, b, { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }], ...extra });
const text = (chars: string, b: ReturnType<typeof box>) =>
  node("TEXT", chars, b, { characters: chars, style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16, lineHeightPx: 20 }, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] });
const page = (children: FigmaNode[], id = "0:1", name = "Page"): FigmaNode => ({ id, name, type: "CANVAS", children });
const docOf = (...pages: FigmaNode[]): DesignDocument => ({ source: "rest", fileName: "test", fileKey: "k", version: "1", pages, image: async () => null });

/** a frame at (x, y) with these children placed relative to it */
function frame(name: string, x: number, y: number, w: number, h: number, kids: (ox: number, oy: number) => FigmaNode[], extra: Record<string, unknown> = {}) {
  return node("FRAME", name, box(x, y, w, h), { clipsContent: true, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], children: kids(x, y), ...extra });
}

describe("design area", () => {
  it("a frame without clip content goes down to the bottom of its content", () => {
    const f = frame("Long", 100, 200, 375, 700, (x, y) => [rect("bg", box(x, y, 375, 1200)), text("Footer", box(x + 10, y + 1180, 100, 20))], { clipsContent: false });
    const [d] = listDesign(docOf(page([f]))).frames;
    expect(d).toMatchObject({ width: 375, height: 700, designHeight: 1200, scrolls: false, viewport: { w: 375, h: 1200 } });
    const spec = extractSpec(docOf(page([f])), d!);
    expect(spec.size).toEqual({ w: 375, h: 1200 });
    expect(spec.nodes.find((n) => n.text?.characters === "Footer")?.box).toEqual({ x: 10, y: 1180, w: 100, h: 20 });
  });

  it("is at most 16000 px high", () => {
    const f = frame("Huge", 0, 0, 375, 700, (x, y) => [rect("bg", box(x, y, 375, 30000))], { clipsContent: false });
    const [d] = listDesign(docOf(page([f]))).frames;
    expect(d!.designHeight).toBe(MAX_HEIGHT);
    expect(d!.viewport.h).toBe(MAX_HEIGHT);
  });

  it("a prototype-scrolling frame goes down to the bottom of what scrolls, its fixed child stays on its screen", () => {
    const f = frame("Phone", 0, 0, 375, 700, (x, y) => [
      rect("content", box(x, y, 375, 2000)),
      text("Last line", box(x + 10, y + 1960, 200, 20)),
      rect("bottom menu", box(x, y + 640, 375, 60), { scrollBehavior: "FIXED" }),
      rect("fixed but below the screen", box(x, y + 900, 375, 60), { scrollBehavior: "FIXED" }),
      rect("after the menu", box(x, y + 100, 50, 50)),
    ], { overflowDirection: "VERTICAL_SCROLLING" });
    const doc = docOf(page([f]));
    const [d] = listDesign(doc).frames;
    expect(d).toMatchObject({ height: 700, designHeight: 2000, scrolls: true, viewport: { w: 375, h: 700 } });
    const spec = extractSpec(doc, d!);
    expect(spec.size).toEqual({ w: 375, h: 2000 });
    expect(spec.viewport).toEqual({ w: 375, h: 700 });
    const names = spec.nodes.map((n) => n.name);
    // drawn above the content that scrolls: last; the one below the screen never shows
    expect(names).toEqual(["Phone", "content", "Last line", "after the menu", "bottom menu"]);
    expect(spec.nodes.at(-1)!.box).toEqual({ x: 0, y: 640, w: 375, h: 60 });
    expect(spec.nodes[0]!.children).toEqual(spec.nodes.slice(1).map((n) => n.id));
  });

  it("a frame that clips its content is its box: what overflows it is left out", () => {
    const f = frame("Desktop", 50, 50, 1280, 800, (x, y) => [
      rect("partly in", box(x, y + 700, 1280, 300)),
      text("Below", box(x + 10, y + 900, 100, 20)),
      node("FRAME", "Carousel", box(x, y + 100, 400, 200), {
        clipsContent: true,
        children: [text("Card 1", box(x + 10, y + 110, 100, 20)), text("Card 9", box(x + 900, y + 110, 100, 20))],
      }),
      rect("hidden", box(x, y, 10, 10), { visible: false }),
    ]);
    const doc = docOf(page([f]));
    const [d] = listDesign(doc).frames;
    expect(d).toMatchObject({ designHeight: 800, scrolls: false, viewport: { w: 1280, h: 800 } });
    const names = extractSpec(doc, d!).nodes.map((n) => n.name);
    expect(names).toEqual(["Desktop", "partly in", "Carousel", "Card 1"]);
  });
});

describe("contentHash", () => {
  const make = (x: number, y: number, label: string, imageRef = "abc") =>
    frame("Home", x, y, 375, 700, (ox, oy) => [
      rect("hero", box(ox, oy, 375, 300), { fills: [{ type: "IMAGE", imageRef, scaleMode: "FILL" }] }),
      text(label, box(ox + 16, oy + 320, 200, 24)),
    ]);
  const hash = (f: FigmaNode) => listDesign(docOf(page([f]))).frames[0]!.contentHash;

  it("is the same for the same frame, whatever its ids and its place on the canvas", () => {
    const a = make(0, 0, "Welcome");
    expect(hash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hash(a)).toBe(hash(structuredClone(a)));
    expect(hash(make(5000, -300, "Welcome"))).toBe(hash(a)); // new ids, other place
  });
  it("changes with a text or an image", () => {
    const a = make(0, 0, "Welcome");
    expect(hash(make(0, 0, "Welcome!"))).not.toBe(hash(a));
    expect(hash(make(0, 0, "Welcome", "def"))).not.toBe(hash(a));
  });
});

describe("drafts and duplicates", () => {
  it("names that mark a draft, and names that do not", () => {
    for (const n of ["Home (old)", "Draft - checkout", "Checkout copy", "WIP cart", "旧ver_TOP", "【削除】TOP", "TOP-2-2", "TOP_コピー", "Test", "backup/top"]) {
      expect(draftName(n), n).toBe(true);
    }
    for (const n of ["航空券の削除", "Bold title", "Testimonials", "DP04(仮)_モーダル", "複雑旅程Ver2", "Gold plan", "Cover", "DP01_検索結果一覧", "2025-12-11"]) {
      expect(draftName(n), n).toBe(false);
    }
  });

  it("hidden, in a draft section, too small, or a duplicate", () => {
    const screen = (name: string, x: number, extra: Record<string, unknown> = {}, label = name) =>
      frame(name, x, 0, 375, 700, (ox, oy) => [text(label, box(ox + 10, oy + 10, 100, 20))], extra);
    const doc = docOf(page([
      screen("Home", 0),
      screen("Home", 400), // same name, same content: a duplicate
      screen("Home", 800, {}, "Other text"), // same name, other content
      screen("Cart", 1200, { visible: false }),
      node("INSTANCE", "Label", box(0, -100, 2000, 60)),
      { ...node("SECTION", "ログイン系初稿", box(0, 1000, 2000, 1000)), children: [screen("Login", 0)] },
      { ...node("SECTION", "Flows", box(0, 3000, 2000, 1000)), children: [{ ...node("SECTION", "Inner", box(0, 3000, 900, 900)), children: [screen("Shop", 0)] }] },
    ]));
    const { groups, frames } = listDesign(doc);
    const by = (name: string) => frames.filter((f) => f.name === name);
    expect(by("Home").map((f) => f.draft)).toEqual([false, false, false]);
    expect(by("Home")[1]!.duplicateOf).toBe(by("Home")[0]!.nodeId);
    expect(by("Home")[2]!.duplicateOf).toBeNull();
    expect(by("Cart")[0]!.draft).toBe(true);
    expect(by("Label")[0]!.draft).toBe(true);
    expect(by("Login")[0]!.draft).toBe(true);
    expect(by("Shop")[0]).toMatchObject({ draft: false, groupNodeId: groups.find((g) => g.name === "Inner")!.nodeId, position: 0 });
    expect(groups.map((g) => [g.kind, g.name, g.position])).toEqual([["page", "Page", 0], ["section", "ログイン系初稿", 0], ["section", "Flows", 1], ["section", "Inner", 0]]);
    expect(groups.find((g) => g.name === "Inner")!.parentNodeId).toBe(groups.find((g) => g.name === "Flows")!.nodeId);
    expect(frames.map((f) => f.position)).toEqual([0, 1, 2, 3, 4, 0, 0]);
  });

  it("a frame left outside the sections of a page whose screens are in sections", () => {
    const screen = (name: string) => frame(name, 0, 0, 375, 700, (ox, oy) => [text(name, box(ox, oy, 10, 10))]);
    const inSections = Array.from({ length: 10 }, (_, i) => screen(`Screen ${i}`));
    const doc = docOf(page([screen("Leftover"), { ...node("SECTION", "Flow", box(0, 0, 9000, 900)), children: inSections }]));
    const { frames } = listDesign(doc);
    expect(frames.find((f) => f.name === "Leftover")!.draft).toBe(true);
    expect(frames.filter((f) => f.draft)).toHaveLength(1);
    // a page with many frames on the canvas: they are its screens
    const mixed = docOf(page([screen("A"), screen("B"), { ...node("SECTION", "Flow", box(0, 0, 9000, 900)), children: inSections.slice(0, 5) }]));
    expect(listDesign(mixed).frames.some((f) => f.draft)).toBe(false);
  });
});
