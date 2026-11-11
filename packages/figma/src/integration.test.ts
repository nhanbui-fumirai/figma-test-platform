/**
 * A real .fig file, when FIG_SAMPLE names one (FIG_SAMPLE=/path/to/design.fig pnpm --filter @figtest/figma test):
 * read it, list its frames, take the spec of a few and draw one in headless Chromium.
 */
import { describe, expect, it } from "vitest";
import { readFigFile } from "./fig";
import { listDesign } from "./frames";
import { FrameRenderer, makeThumbnail } from "./render";
import { extractSpec } from "./spec";

const sample = process.env.FIG_SAMPLE;

describe.skipIf(!sample)("a real .fig file (FIG_SAMPLE)", () => {
  it("reads, lists, extracts and renders", async () => {
    const doc = await readFigFile(sample!);
    expect(doc.pages.length).toBeGreaterThan(0);
    const { groups, frames } = listDesign(doc);
    expect(groups.filter((g) => g.kind === "page")).toHaveLength(doc.pages.length);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(f.designHeight).toBeGreaterThanOrEqual(Math.min(Math.round(f.height), 16000) - 1);
      expect(f.viewport.w).toBe(Math.max(1, Math.round(f.width)));
    }
    // the same file read again: the same hashes
    const again = listDesign(await readFigFile(sample!)).frames;
    expect(again.map((f) => f.contentHash)).toEqual(frames.map((f) => f.contentHash));

    const screens = frames.filter((f) => !f.draft).slice(0, 3);
    for (const f of screens) {
      const spec = extractSpec(doc, f);
      expect(spec.nodes[0]!.id).toBe(f.nodeId);
      expect(spec.size).toEqual({ w: f.viewport.w, h: f.designHeight });
    }
    const renderer = await FrameRenderer.launch();
    try {
      const target = screens[0] ?? frames[0]!;
      const r = await renderer.render(doc, target);
      expect(r.width).toBe(target.viewport.w);
      expect(r.height).toBe(target.designHeight);
      expect(r.png.subarray(1, 4).toString()).toBe("PNG");
      const thumb = await makeThumbnail(r.png);
      expect(thumb.subarray(1, 4).toString()).toBe("PNG");
    } finally {
      await renderer.close();
    }
  }, 300_000);
});
