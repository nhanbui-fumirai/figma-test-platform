import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { framePage, frameHtml } from "./html";
import { makeThumbnail } from "./render";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("frameHtml", () => {
  const frame = {
    id: "1:1", name: "Screen", type: "FRAME", clipsContent: true, absoluteBoundingBox: box(100, 100, 375, 700),
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [
      { id: "1:2", name: "Hero", type: "RECTANGLE", absoluteBoundingBox: box(100, 100, 375, 200), fills: [{ type: "IMAGE", imageRef: "abc123", scaleMode: "FILL" }], cornerRadius: 8 },
      {
        id: "1:3", name: "Title", type: "TEXT", absoluteBoundingBox: box(116, 320, 200, 40), characters: "Tom & Jerry\nLine 2", lineStarts: [0, 12],
        style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16, lineHeightPx: 20, textAlignHorizontal: "CENTER" }, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
      },
      {
        id: "1:4", name: "Chevron", type: "VECTOR", absoluteBoundingBox: box(300, 400, 10, 20), size: { x: 20, y: 10 }, relativeTransform: [[0, -1, 210], [1, 0, 300]],
        fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }], fillGeometry: [{ path: "M0 0L20 5L0 10Z", windingRule: "NONZERO" }],
      },
      { id: "1:5", name: "Below", type: "TEXT", absoluteBoundingBox: box(100, 900, 50, 20), characters: "never shown", style: {} },
    ],
  };

  it("draws the design area of the frame: images, text, turned vectors", () => {
    const html = frameHtml(frame);
    expect(html.width).toBe(375);
    expect(html.height).toBe(700);
    expect([...html.images]).toEqual(["abc123"]);
    expect([...html.fonts.keys()]).toEqual(["Inter"]);
    expect(html.body).toContain("url('/img/abc123') center/cover no-repeat");
    expect(html.body).toContain("Tom &amp; Jerry\nLine 2");
    expect(html.body).toContain("transform:matrix(0,1,-1,0,0,0)");
    expect(html.body).toContain('d="M0 0L20 5L0 10Z"');
    expect(html.body).not.toContain("never shown");
    expect(framePage(html, "/* fonts */")).toContain("width:375px;height:700px");
  });
});

describe("makeThumbnail", () => {
  const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();
  it("is `width` px wide, in proportion", async () => {
    const meta = await sharp(await makeThumbnail(await png(1280, 800))).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([320, 200, "png"]);
  });
  it("cuts a tall page at 4 × the width, from the top", async () => {
    const meta = await sharp(await makeThumbnail(await png(375, 5000), 100)).metadata();
    expect([meta.width, meta.height]).toEqual([100, 400]);
  });
});
