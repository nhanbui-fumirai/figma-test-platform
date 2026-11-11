import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import { compileSchema, encodeBinarySchema, parseSchema } from "kiwi-schema";
import { describe, expect, it } from "vitest";
import { buildDocument, decodeFigCanvas, readFigFile } from "./fig";
import { listDesign } from "./frames";
import type { FigmaNode } from "./types";

const g = (sessionID: number, localID: number) => ({ sessionID, localID });
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const parent = (id: ReturnType<typeof g>, position: string) => ({ guid: id, position });
const solid = (r: number, gr: number, b: number) => [{ type: "SOLID", color: { r, g: gr, b, a: 1 }, opacity: 1, visible: true }];

/** a small file: a page with a frame holding an instance (with overrides), a group and a rotated vector */
function changes() {
  return [
    { guid: g(0, 0), type: "DOCUMENT", name: "Doc" },
    { guid: g(0, 1), parentIndex: parent(g(0, 0), "!"), type: "CANVAS", name: "Page 1" },
    { guid: g(0, 2), parentIndex: parent(g(0, 0), "~"), type: "CANVAS", name: "Internal Only Canvas", internalOnly: true },
    // a component: a 100 x 40 button with a label
    { guid: g(1, 1), parentIndex: parent(g(0, 2), "!"), type: "SYMBOL", name: "Button", size: { x: 100, y: 40 }, transform: at(0, 0), fillPaints: solid(0, 0, 1) },
    {
      guid: g(1, 2), parentIndex: parent(g(1, 1), "!"), type: "TEXT", name: "Label", size: { x: 80, y: 20 }, transform: at(10, 10), overrideKey: g(7, 7),
      textData: { characters: "Label" }, fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 14, lineHeight: { units: "PIXELS", value: 20 }, fillPaints: solid(1, 1, 1),
    },
    // the screen
    { guid: g(2, 1), parentIndex: parent(g(0, 1), "!"), type: "FRAME", name: "Home", size: { x: 375, y: 700 }, transform: at(100, 200), fillPaints: solid(1, 1, 1) },
    {
      guid: g(2, 2), parentIndex: parent(g(2, 1), "!"), type: "INSTANCE", name: "Buy button", size: { x: 120, y: 40 }, transform: at(20, 30),
      symbolData: { symbolID: g(1, 1), symbolOverrides: [{ guidPath: { guids: [g(7, 7)] }, textData: { characters: "Buy now" }, size: { x: 50, y: 20 } }] },
      derivedSymbolData: [{ guidPath: { guids: [g(7, 7)] }, size: { x: 90, y: 20 } }],
    },
    { guid: g(2, 3), parentIndex: parent(g(2, 1), "#"), type: "FRAME", name: "Group 1", resizeToFit: true, size: { x: 50, y: 50 }, transform: at(200, 300) },
    { guid: g(2, 4), parentIndex: parent(g(2, 3), "!"), type: "ROUNDED_RECTANGLE", name: "Dot", size: { x: 10, y: 10 }, transform: at(5, 5), fillPaints: solid(1, 0, 0) },
    // an arrow turned by 90° (x' = -y, y' = x)
    { guid: g(2, 5), parentIndex: parent(g(2, 1), "$"), type: "VECTOR", name: "Arrow", size: { x: 20, y: 10 }, transform: { m00: 0, m01: -1, m02: 50, m10: 1, m11: 0, m12: 60 } },
    { guid: g(2, 6), parentIndex: parent(g(2, 1), "%"), type: "TEXT", name: "Gone", phase: "REMOVED" },
  ];
}

describe("buildDocument (.fig → REST shape)", () => {
  const { pages, components } = buildDocument(changes(), []);
  const home = pages[0]!.children[0] as FigmaNode;
  const kids = home.children!;

  it("builds the tree of the pages, without the internal canvas nor removed nodes", () => {
    expect(pages.map((p) => p.name)).toEqual(["Page 1"]);
    expect(home).toMatchObject({ id: "2:1", type: "FRAME", absoluteBoundingBox: { x: 100, y: 200, width: 375, height: 700 }, clipsContent: true });
    expect(kids.map((k) => k.name)).toEqual(["Buy button", "Group 1", "Arrow"]);
    expect(components["1:1"]).toMatchObject({ name: "Button" });
  });

  it("expands an instance with REST ids, its overrides and its derived sizes", () => {
    const inst = kids[0]!;
    expect(inst).toMatchObject({ type: "INSTANCE", componentId: "1:1", absoluteBoundingBox: { x: 120, y: 230, width: 120, height: 40 } });
    const label = inst.children![0]!;
    // derivedSymbolData (90, after layout) wins over the override size (50)
    expect(label).toMatchObject({ id: "I2:2;1:2", characters: "Buy now", absoluteBoundingBox: { x: 130, y: 240, width: 90, height: 20 }, relativeTransform: [[1, 0, 10], [0, 1, 10]] });
    expect(label.style).toMatchObject({ fontFamily: "Inter", fontWeight: 600, fontSize: 14, lineHeightPx: 20, lineHeightUnit: "PIXELS" });
  });

  it("makes a group of a frame that hugs its children; their transform is relative to the frame above", () => {
    const group = kids[1]!;
    expect(group.type).toBe("GROUP");
    expect(group.clipsContent).toBeUndefined();
    expect(group.children![0]).toMatchObject({ type: "RECTANGLE", absoluteBoundingBox: { x: 305, y: 505, width: 10, height: 10 }, relativeTransform: [[1, 0, 205], [0, 1, 305]] });
  });

  it("turns the box of a rotated node", () => {
    expect(kids[2]).toMatchObject({ absoluteBoundingBox: { x: 140, y: 260, width: 10, height: 20 }, size: { x: 20, y: 10 }, relativeTransform: [[0, -1, 50], [1, 0, 60]] });
  });
});

// ---------------------------------------------------------------- the binary format, with a small kiwi schema

const SCHEMA = `
package fig;
enum NodeType { DOCUMENT = 1; CANVAS = 2; FRAME = 3; TEXT = 4; }
struct GUID { uint sessionID; uint localID; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Vector { float x = 1; float y = 2; }
message Matrix { float m00 = 1; float m01 = 2; float m02 = 3; float m10 = 4; float m11 = 5; float m12 = 6; }
message TextData { string characters = 1; }
message NodeChange { GUID guid = 1; ParentIndex parentIndex = 2; NodeType type = 3; string name = 4; Vector size = 5; Matrix transform = 6; TextData textData = 7; float fontSize = 8; }
message Message { NodeChange[] nodeChanges = 1; }
`;

function canvasFig(nodeChanges: unknown[]): Buffer {
  const schema = parseSchema(SCHEMA);
  const data = Buffer.from(compileSchema(schema).encodeMessage({ nodeChanges }));
  const chunk = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return [len, b];
  };
  const version = Buffer.alloc(4);
  version.writeUInt32LE(106);
  return Buffer.concat([Buffer.from("fig-kiwi"), version, ...chunk(zlib.deflateRawSync(Buffer.from(encodeBinarySchema(schema)))), ...chunk(zlib.zstdCompressSync(data))]);
}

const smallFile = () => canvasFig([
  { guid: g(0, 0), type: "DOCUMENT", name: "Doc" },
  { guid: g(0, 1), parentIndex: parent(g(0, 0), "!"), type: "CANVAS", name: "Page" },
  { guid: g(1, 1), parentIndex: parent(g(0, 1), "!"), type: "FRAME", name: "Screen", size: { x: 320, y: 480 }, transform: at(0, 0) },
  { guid: g(1, 2), parentIndex: parent(g(1, 1), "!"), type: "TEXT", name: "Hello", size: { x: 100, y: 20 }, transform: at(10, 10), textData: { characters: "Hello" }, fontSize: 16 },
]);

describe("readFigFile", () => {
  it("decodes canvas.fig: header, chunks, deflate-raw schema, zstd data", () => {
    const msg = decodeFigCanvas(smallFile());
    expect(msg.nodeChanges.map((n) => n.name)).toEqual(["Doc", "Page", "Screen", "Hello"]);
    expect(() => decodeFigCanvas(Buffer.from("not a figma file at all"))).toThrow(/not a Figma file/);
  });

  it("reads a .fig zip with its meta and its images", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figtest-"));
    try {
      const zip = new JSZip();
      zip.file("canvas.fig", smallFile());
      zip.file("meta.json", JSON.stringify({ file_name: "My design", exported_at: "2026-01-02T03:04:05.000Z" }));
      zip.file("images/0123456789abcdef0123456789abcdef01234567", Buffer.from([9, 8, 7]));
      const file = path.join(dir, "design.fig");
      fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
      const doc = await readFigFile(file);
      expect(doc).toMatchObject({ source: "fig", fileName: "My design", fileKey: null, version: "2026-01-02T03:04:05.000Z" });
      expect(await doc.image("0123456789abcdef0123456789abcdef01234567")).toEqual(Buffer.from([9, 8, 7]));
      expect(await doc.image("ffffffffffffffffffffffffffffffffffffffff")).toBeNull();
      const { frames } = listDesign(doc);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.node.children![0]).toMatchObject({ id: "1:2", characters: "Hello", style: { fontSize: 16 } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
