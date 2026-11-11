/**
 * Reads a .fig file (Figma → Main menu → File → Save local copy) without any Figma call or token, into the shape of
 * the REST API (GET /v1/files/:key?geometry=paths), so the rest of the package works the same for both sources.
 *
 * .fig layout: a ZIP with canvas.fig (+ meta.json, thumbnail.png, images/<sha1>), or canvas.fig alone.
 * canvas.fig = "fig-kiwi" + uint32 version + chunks [uint32 length][bytes]: chunk 0 = kiwi schema, chunk 1 = the
 * document (zstd, or deflate-raw in older files) = a flat list of NodeChange { guid, parentIndex, ... } + blobs.
 *
 * What differs from the REST JSON and is rebuilt here:
 *   - the tree: parentIndex { guid, position } → children sorted by position
 *   - absoluteBoundingBox from the composed transforms and sizes; relativeTransform like REST: relative to the nearest
 *     container (groups and boolean operations are not containers: their children are relative to the frame above)
 *   - instances have no children in the file: the children of their component (SYMBOL) are copied with the ids the
 *     REST API gives them ("I<instance>;<child>"), then symbolOverrides (matched by the overrideKey path),
 *     derivedSymbolData (sizes and places after auto layout and constraints: they win over a stale override size) and
 *     component properties (text, visibility, instance swap) are applied; the overrides of an outer instance reach
 *     into the nested ones and win over theirs
 *   - a node that an override binds to another color / text style takes the paints / font of that style (the
 *     override names the style only)
 *   - kiwi leaves out fields equal to 0 (padding, spacing, radius): a missing number means 0
 *   - text: line height and letter spacing in px; "auto" line height from the laid out text (derivedTextData), and
 *     lineStarts (first character of each line Figma laid out; not in REST) so the renderer breaks lines there too
 *   - vectors, lines, ellipses and masks: fillGeometry / strokeGeometry point to binary path blobs; they become SVG
 *     path strings like REST ?geometry=paths gives (the stroke geometry is the outline of the stroke, to be filled)
 *   - gradients: the paint transform becomes gradientHandlePositions
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";
import type { DesignDocument } from "./types";
import { type AnyNode, r2, weightOfStyle } from "./util";

type Guid = { sessionID: number; localID: number };
type NC = AnyNode; // a NodeChange as decoded by kiwi
type Blob = { bytes: Uint8Array };

const gid = (g: Guid | undefined | null) => (g ? `${g.sessionID}:${g.localID}` : "");
const hexOf = (bytes: Uint8Array | undefined) => (bytes ? Buffer.from(bytes).toString("hex") : "");
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------- decode

/** canvas.fig bytes → the decoded message { nodeChanges, blobs }. */
export function decodeFigCanvas(buf: Buffer): { nodeChanges: NC[]; blobs: Blob[] } {
  if (buf.subarray(0, 4).toString("latin1") !== "fig-") throw new Error("not a Figma file (no fig-kiwi header)");
  const chunks: Buffer[] = [];
  for (let off = 12; off + 4 <= buf.length;) {
    const len = buf.readUInt32LE(off);
    chunks.push(buf.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  const [schemaChunk, dataChunk] = chunks;
  if (!schemaChunk || !dataChunk) throw new Error("not a Figma file (missing chunks)");
  const inflate = (b: Buffer): Buffer => {
    if (b.length >= 4 && b.readUInt32LE(0) === 0xfd2fb528) return zlib.zstdDecompressSync(b);
    try {
      return zlib.inflateRawSync(b);
    } catch {
      return zlib.inflateSync(b);
    }
  };
  const schema = compileSchema(decodeBinarySchema(inflate(schemaChunk)));
  const msg = schema.decodeMessage(inflate(dataChunk));
  return { nodeChanges: msg.nodeChanges ?? [], blobs: msg.blobs ?? [] };
}

/** Reads a .fig file (zip with canvas.fig + images, or canvas.fig alone) into a REST-shaped document. */
export async function readFigFile(file: string): Promise<DesignDocument> {
  const bytes = await fs.promises.readFile(file);
  let canvas: Buffer = bytes;
  let meta: AnyNode = {};
  let zip: JSZip | null = null;
  if (bytes.subarray(0, 2).toString("latin1") === "PK") {
    zip = await JSZip.loadAsync(bytes);
    const entry = zip.file("canvas.fig");
    if (!entry) throw new Error(`${path.basename(file)}: no canvas.fig inside, not a Figma file`);
    canvas = await entry.async("nodebuffer");
    const m = zip.file("meta.json");
    if (m) {
      try {
        meta = JSON.parse(await m.async("string"));
      } catch {
        meta = {};
      }
    }
  }
  const msg = decodeFigCanvas(canvas);
  const built = buildDocument(msg.nodeChanges, msg.blobs);
  const images = zip;
  return {
    source: "fig",
    fileName: (typeof meta.file_name === "string" && meta.file_name) || built.name || path.basename(file).replace(/\.fig$/i, ""),
    fileKey: null,
    version: typeof meta.exported_at === "string" ? meta.exported_at : "",
    pages: built.pages as DesignDocument["pages"],
    components: built.components,
    componentSets: built.componentSets,
    async image(ref: string) {
      if (!images || !/^[0-9a-f]{8,64}$/i.test(ref)) return null;
      const f = images.file(`images/${ref.toLowerCase()}`) ?? images.file(`images/${ref}`);
      return f ? f.async("nodebuffer") : null;
    },
  };
}

// ---------------------------------------------------------------- tree

type Ctx = {
  byId: Map<string, NC>;
  kids: Map<string, NC[]>;
  blobs: Blob[];
  /** style nodes by "key@version" and by key */
  styles: Map<string, NC>;
};

export function buildDocument(changes: NC[], blobs: Blob[]) {
  const byId = new Map<string, NC>();
  for (const n of changes) {
    if (n.phase === "REMOVED" || n.isSoftDeleted) continue;
    byId.set(gid(n.guid), n);
  }
  const kids = new Map<string, NC[]>();
  const styles = new Map<string, NC>();
  for (const n of byId.values()) {
    const p = gid(n.parentIndex?.guid);
    if (p) {
      let list = kids.get(p);
      if (!list) kids.set(p, (list = []));
      list.push(n);
    }
    if (n.styleType && n.key) {
      styles.set(`${n.key}@${n.version ?? ""}`, n);
      styles.set(n.key, n);
    }
  }
  const pos = (n: NC): string => n.parentIndex?.position ?? "";
  for (const list of kids.values()) list.sort((a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0));

  const components: Record<string, { key: string; name: string; description: string; componentSetId?: string }> = {};
  const componentSets: Record<string, { key: string; name: string; description: string }> = {};
  for (const n of byId.values()) {
    if (n.type === "SYMBOL") {
      const parent = byId.get(gid(n.parentIndex?.guid));
      components[gid(n.guid)] = {
        key: n.componentKey ?? "", name: n.name ?? "", description: n.symbolDescription ?? "",
        ...(parent?.isStateGroup ? { componentSetId: gid(parent.guid) } : {}),
      };
    } else if (n.type === "FRAME" && n.isStateGroup) {
      componentSets[gid(n.guid)] = { key: n.componentKey ?? "", name: n.name ?? "", description: n.symbolDescription ?? "" };
    }
  }
  const root = [...byId.values()].find((n) => n.type === "DOCUMENT");
  if (!root) throw new Error("no DOCUMENT node in the .fig");
  const ctx: Ctx = { byId, kids, blobs, styles };
  const pages: AnyNode[] = [];
  for (const page of kids.get(gid(root.guid)) ?? []) {
    // the "Internal Only Canvas" holds the components of the libraries used by instances: not a page of the file
    if (page.type !== "CANVAS" || page.internalOnly) continue;
    const out: AnyNode = { id: gid(page.guid), name: page.name ?? "", type: "CANVAS", children: [] };
    if (page.backgroundColor) out.backgroundColor = page.backgroundColor;
    for (const child of kids.get(gid(page.guid)) ?? []) out.children.push(convert(child, ctx, IDENTITY, IDENTITY, ""));
    pages.push(out);
  }
  return { name: root.name as string | undefined, pages, components, componentSets };
}

// ---------------------------------------------------------------- geometry

type M = [number, number, number, number, number, number]; // m00 m01 m02 m10 m11 m12
const IDENTITY: M = [1, 0, 0, 0, 1, 0];
const toM = (t: NC | undefined): M => (t ? [t.m00 ?? 1, t.m01 ?? 0, t.m02 ?? 0, t.m10 ?? 0, t.m11 ?? 1, t.m12 ?? 0] : IDENTITY);
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
  a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5],
];
function inverse(a: M): M {
  const det = a[0] * a[4] - a[1] * a[3];
  if (!det) return IDENTITY;
  return [a[4] / det, -a[1] / det, (a[1] * a[5] - a[4] * a[2]) / det, -a[3] / det, a[0] / det, (a[3] * a[2] - a[0] * a[5]) / det];
}
function bbox(m: M, w: number, h: number) {
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x = 0, y = 0]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]] as const);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: r2(x), y: r2(y), width: r2(Math.max(...xs) - x), height: r2(Math.max(...ys) - y) };
}
const restTransform = (m: M) => [[r4(m[0]), r4(m[1]), r2(m[2])], [r4(m[3]), r4(m[4]), r2(m[5])]];

/**
 * Path commands blob → SVG path data, scaled by (sx, sy): [uint8 command][float32 LE args]...
 * 0 close, 1 moveTo x y, 2 lineTo x y, 3 quadTo cx cy x y, 4 cubicTo c1x c1y c2x c2y x y.
 */
function svgPath(bytes: Uint8Array, sx = 1, sy = 1): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ARGS: Record<number, [string, number]> = { 0: ["Z", 0], 1: ["M", 2], 2: ["L", 2], 3: ["Q", 4], 4: ["C", 6] };
  const out: string[] = [];
  for (let off = 0; off < bytes.length;) {
    const cmd = ARGS[bytes[off++] ?? -1];
    if (!cmd || off + cmd[1] * 4 > bytes.length) break; // unknown command: keep what was read
    const nums: number[] = [];
    for (let k = 0; k < cmd[1]; k++, off += 4) nums.push(Math.round(view.getFloat32(off, true) * (k % 2 ? sy : sx) * 100) / 100);
    out.push(cmd[0] + nums.join(" "));
  }
  return out.join("");
}

function geometry(list: NC[] | undefined, ctx: Ctx, sx: number, sy: number) {
  return (list ?? [])
    .map((g) => ({ path: svgPath(ctx.blobs[g.commandsBlob]?.bytes ?? new Uint8Array(), sx, sy), windingRule: g.windingRule === "ODD" ? "EVENODD" : "NONZERO" }))
    .filter((g) => g.path);
}

// ---------------------------------------------------------------- paints, styles, text

/** Gradient paint transform (node unit square → gradient space) → REST gradientHandlePositions (node unit square). */
function gradientHandles(t: NC | undefined) {
  const inv = inverse(toM(t));
  const at = (x: number, y: number) => ({ x: r4(inv[0] * x + inv[1] * y + inv[2]), y: r4(inv[3] * x + inv[4] * y + inv[5]) });
  return [at(0, 0.5), at(1, 0.5), at(0, 1)];
}

function paints(list: NC[] | undefined): AnyNode[] {
  return (list ?? []).map((p) => {
    const out: AnyNode = { type: p.type, visible: p.visible !== false, opacity: p.opacity ?? 1, blendMode: p.blendMode ?? "NORMAL" };
    if (p.color) out.color = { r: p.color.r ?? 0, g: p.color.g ?? 0, b: p.color.b ?? 0, a: p.color.a ?? 1 };
    if (p.type === "IMAGE") {
      out.imageRef = hexOf(p.image?.hash);
      out.scaleMode = p.imageScaleMode ?? "FILL";
      // "Crop" in Figma: the part of the image shown, as REST gives it (node unit square → image unit square)
      const t = p.transform;
      if (out.scaleMode === "STRETCH" && t) out.imageTransform = [[t.m00 ?? 1, t.m01 ?? 0, t.m02 ?? 0], [t.m10 ?? 0, t.m11 ?? 1, t.m12 ?? 0]];
      if (out.scaleMode === "TILE" && p.scale) out.scalingFactor = p.scale;
      if (p.rotation) out.rotation = p.rotation;
      if (p.originalImageWidth && p.originalImageHeight) out.originalImageSize = { width: p.originalImageWidth, height: p.originalImageHeight };
    }
    if (String(p.type).startsWith("GRADIENT")) {
      out.gradientStops = (p.stops ?? []).map((s: NC) => ({ position: s.position ?? 0, color: { r: s.color?.r ?? 0, g: s.color?.g ?? 0, b: s.color?.b ?? 0, a: s.color?.a ?? 1 } }));
      out.gradientHandlePositions = gradientHandles(p.transform);
    }
    return out;
  });
}

const refKey = (ref: NC | undefined): string => (ref?.assetRef?.key ? String(ref.assetRef.key) : gid(ref?.guid));

function findStyle(ctx: Ctx, ref: NC | undefined): NC | undefined {
  if (!ref) return undefined;
  if (ref.assetRef?.key) return ctx.styles.get(`${ref.assetRef.key}@${ref.assetRef.version ?? ""}`) ?? ctx.styles.get(ref.assetRef.key);
  return ref.guid ? ctx.byId.get(gid(ref.guid)) : undefined;
}

/**
 * The paints of a node: its own, unless an override (patch) binds it to another color style than the component's
 * node without giving the paints: then those of the style.
 */
function resolvePaints(ctx: Ctx, base: NC, patch: NC | undefined, refField: string, paintField: string): NC[] | undefined {
  const ref = patch?.[refField];
  if (ref && !patch?.[paintField] && refKey(ref) !== refKey(base[refField])) {
    const style = findStyle(ctx, ref);
    if (Array.isArray(style?.fillPaints)) return style.fillPaints;
  }
  const own = patch?.[paintField] ?? base[paintField];
  if (!own && base[refField]) return findStyle(ctx, base[refField])?.fillPaints;
  return own;
}

const TEXT_STYLE_FIELDS = ["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration"];

/** Text fields of the text style an override binds the node to (when it does not give them itself). */
function textStyleFields(ctx: Ctx, base: NC, patch: NC | undefined): NC | undefined {
  const ref = patch?.styleIdForText;
  if (!ref || patch?.fontName || patch?.fontSize || refKey(ref) === refKey(base.styleIdForText)) return undefined;
  const style = findStyle(ctx, ref);
  if (!style) return undefined;
  return Object.fromEntries(TEXT_STYLE_FIELDS.filter((k) => style[k] !== undefined).map((k) => [k, style[k]]));
}

const pxOf = (v: NC | undefined, size: number) => (!v ? 0 : v.units === "PIXELS" ? v.value ?? 0 : v.units === "PERCENT" ? (size * (v.value ?? 0)) / 100 : size * (v.value ?? 0));

function textStyle(n: NC): AnyNode {
  const size: number = n.fontSize ?? 12;
  // like REST: RAW = multiplier of the font size, PIXELS, PERCENT; 100 % is "Auto" = the natural line of the font,
  // which only the laid out text knows (derivedTextData baselines)
  const baselines = n.derivedTextData?.baselines;
  const lh = n.lineHeight;
  const auto = !lh || (lh.units === "PERCENT" && lh.value === 100);
  const lineHeightPx: number | undefined = auto ? (baselines?.length ? baselines[0].lineHeight : undefined) : pxOf(lh, size);
  const style: AnyNode = {
    fontFamily: n.fontName?.family ?? "",
    fontPostScriptName: n.fontName?.postscript || undefined,
    fontStyle: n.fontName?.style || undefined,
    fontWeight: weightOfStyle(n.fontName?.style),
    italic: /italic|oblique/i.test(n.fontName?.style ?? "") || undefined,
    fontSize: size,
    textAlignHorizontal: n.textAlignHorizontal ?? "LEFT",
    textAlignVertical: n.textAlignVertical ?? "TOP",
    letterSpacing: r2(pxOf(n.letterSpacing, size)),
    lineHeightPx: lineHeightPx != null ? r2(lineHeightPx) : r2(size * 1.2),
    lineHeightUnit: auto ? "INTRINSIC_%" : lh.units === "PIXELS" ? "PIXELS" : "FONT_SIZE_%",
    textCase: n.textCase && n.textCase !== "ORIGINAL" ? n.textCase : undefined,
    textDecoration: n.textDecoration && n.textDecoration !== "NONE" ? n.textDecoration : undefined,
    textAutoResize: n.textAutoResize ?? "NONE",
    textTruncation: n.textTruncation === "ENDING" ? "ENDING" : undefined,
    maxLines: n.textTruncation === "ENDING" && n.maxLines ? n.maxLines : undefined,
    paragraphSpacing: n.paragraphSpacing || undefined,
  };
  for (const k of Object.keys(style)) if (style[k] === undefined) delete style[k];
  return style;
}

/** A style run of a text (styleOverrideTable entry) as a REST TypeStyle part. */
function runStyle(ctx: Ctx, o: NC, baseSize: number): AnyNode {
  const fromStyle = !o.fontName && o.styleIdForText ? findStyle(ctx, o.styleIdForText) : undefined;
  const src: NC = { ...(fromStyle ? Object.fromEntries(TEXT_STYLE_FIELDS.map((k) => [k, fromStyle[k]])) : {}), ...o };
  const out: AnyNode = {};
  const size: number = src.fontSize ?? baseSize;
  if (src.fontSize) out.fontSize = src.fontSize;
  if (src.fontName) {
    out.fontFamily = src.fontName.family;
    out.fontWeight = weightOfStyle(src.fontName.style);
    if (/italic|oblique/i.test(src.fontName.style ?? "")) out.italic = true;
  }
  const fills = !o.fillPaints && o.styleIdForFill ? findStyle(ctx, o.styleIdForFill)?.fillPaints : o.fillPaints;
  if (fills) out.fills = paints(fills);
  if (src.textDecoration) out.textDecoration = src.textDecoration;
  if (src.textCase) out.textCase = src.textCase;
  if (src.letterSpacing) out.letterSpacing = r2(pxOf(src.letterSpacing, size));
  if (src.lineHeight && !(src.lineHeight.units === "PERCENT" && src.lineHeight.value === 100)) out.lineHeightPx = r2(pxOf(src.lineHeight, size));
  return out;
}

function interactions(n: NC) {
  return (n.prototypeInteractions ?? []).filter((i: NC) => !i.isDeleted).map((i: NC) => ({
    trigger: { type: i.event?.interactionType ?? "ON_CLICK" },
    actions: (i.actions ?? []).map((a: NC) =>
      a.connectionType === "BACK" ? { type: "BACK" }
        : a.connectionType === "URL" ? { type: "URL", url: a.connectionURL }
          : a.transitionNodeID ? { type: "NODE", destinationId: gid(a.transitionNodeID), navigation: a.navigationType ?? "NAVIGATE" }
            : { type: a.connectionType ?? "NONE" }),
  }));
}

// ---------------------------------------------------------------- conversion

const VECTORS = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "LINE", "ELLIPSE"]);
const SCROLLS: Record<string, string> = { HORIZONTAL: "HORIZONTAL_SCROLLING", VERTICAL: "VERTICAL_SCROLLING", BOTH: "HORIZONTAL_AND_VERTICAL_SCROLLING" };

function nodeType(n: NC): string {
  if (n.type === "ROUNDED_RECTANGLE") return "RECTANGLE";
  if (n.type === "SYMBOL") return "COMPONENT";
  if (n.type === "FRAME" && n.isStateGroup) return "COMPONENT_SET";
  // a group is stored as a frame that hugs its children
  if (n.type === "FRAME" && n.resizeToFit) return "GROUP";
  return n.type ?? "FRAME";
}

/**
 * NodeChange → REST node. `parent` = absolute transform of the parent, `container` = of the nearest container
 * (relativeTransform is relative to it); `prefix` = "I<instance>;" when the node is a copy inside an instance.
 */
function convert(n: NC, ctx: Ctx, parent: M, container: M, prefix: string, ov?: Overrides): AnyNode {
  const id = prefix + gid(n.guid);
  const patch = ov?.get(n);
  let local: NC = patch ? { ...n, ...patch } : n;
  const fromTextStyle = n.type === "TEXT" ? textStyleFields(ctx, n, patch) : undefined;
  if (fromTextStyle) local = { ...local, ...fromTextStyle };
  const m = mul(parent, toM(local.transform));
  const w: number = local.size?.x ?? 0, h: number = local.size?.y ?? 0;
  const type = nodeType(local);
  const out: AnyNode = { id, name: local.name ?? "", type };
  if (local.visible === false) out.visible = false;
  if (local.opacity != null && local.opacity !== 1) out.opacity = r4(local.opacity);
  if (local.blendMode && local.blendMode !== "PASS_THROUGH" && local.blendMode !== "NORMAL") out.blendMode = local.blendMode;
  out.absoluteBoundingBox = bbox(m, w, h);
  out.relativeTransform = restTransform(mul(inverse(container), m));
  out.size = { x: r2(w), y: r2(h) };

  out.fills = paints(resolvePaints(ctx, n, patch, "styleIdForFill", "fillPaints"));
  out.strokes = paints(resolvePaints(ctx, n, patch, "styleIdForStrokeFill", "strokePaints"));
  if (out.strokes.length) {
    out.strokeWeight = local.strokeWeight ?? 0;
    out.strokeAlign = local.strokeAlign ?? "CENTER";
    if (local.borderStrokeWeightsIndependent) {
      out.individualStrokeWeights = { top: local.borderTopWeight ?? 0, right: local.borderRightWeight ?? 0, bottom: local.borderBottomWeight ?? 0, left: local.borderLeftWeight ?? 0 };
    }
    if (Array.isArray(local.dashPattern) && local.dashPattern.length) out.strokeDashes = local.dashPattern;
  }
  if (local.cornerRadius) out.cornerRadius = local.cornerRadius;
  if (local.rectangleCornerRadiiIndependent) {
    out.rectangleCornerRadii = [local.rectangleTopLeftCornerRadius ?? 0, local.rectangleTopRightCornerRadius ?? 0, local.rectangleBottomRightCornerRadius ?? 0, local.rectangleBottomLeftCornerRadius ?? 0];
  }
  if (local.effects?.length) {
    out.effects = local.effects.map((e: NC) => ({
      type: e.type, visible: e.visible !== false, radius: e.radius ?? 0, color: e.color, offset: e.offset ?? { x: 0, y: 0 }, spread: e.spread ?? 0,
      ...(e.showShadowBehindNode ? { showShadowBehindNode: true } : {}),
    }));
  }
  if (local.stackMode && local.stackMode !== "NONE") {
    out.layoutMode = local.stackMode;
    out.itemSpacing = local.stackSpacing ?? 0;
    out.paddingLeft = local.stackHorizontalPadding ?? 0;
    out.paddingTop = local.stackVerticalPadding ?? 0;
    out.paddingRight = local.stackPaddingRight ?? 0;
    out.paddingBottom = local.stackPaddingBottom ?? 0;
    out.primaryAxisAlignItems = local.stackPrimaryAlignItems ?? "MIN";
    out.counterAxisAlignItems = local.stackCounterAlignItems ?? "MIN";
    if (local.stackWrap === "WRAP") out.layoutWrap = "WRAP";
  }
  if (local.stackPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
  // like REST: frames say whether they clip their content; groups never clip (no clipsContent)
  if (["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(type)) out.clipsContent = !local.frameMaskDisabled;
  // prototype scrolling, named like REST: a frame that scrolls is one screen high, its content goes on below it; a
  // child that stays on the screen while it scrolls (a bottom menu) has scrollBehavior FIXED
  const scroll = SCROLLS[local.scrollDirection as string];
  if (scroll) out.overflowDirection = scroll;
  if (local.scrollBehavior === "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME") out.scrollBehavior = "FIXED";
  else if (local.scrollBehavior === "STICKY_SCROLLS") out.scrollBehavior = "STICKY_SCROLLS";
  // a mask clips the siblings above it (REST: isMask, maskType ALPHA | VECTOR | LUMINANCE)
  if (local.mask) {
    out.isMask = true;
    out.maskType = local.maskType === "OUTLINE" ? "VECTOR" : local.maskType === "LUMINANCE" ? "LUMINANCE" : "ALPHA";
  }
  if (local.arcData && type === "ELLIPSE") out.arcData = { startingAngle: local.arcData.startingAngle ?? 0, endingAngle: local.arcData.endingAngle ?? 2 * Math.PI, innerRadius: local.arcData.innerRadius ?? 0 };
  if (VECTORS.has(type) || local.mask) {
    // an instance resized without new geometry: the paths of the component, scaled to the new size
    const scale = (own: unknown): [number, number] => ((own === n.fillGeometry || own === n.strokeGeometry) && n.size?.x && n.size?.y ? [w / n.size.x, h / n.size.y] : [1, 1]);
    const fill = geometry(local.fillGeometry, ctx, ...scale(local.fillGeometry));
    const stroke = geometry(local.strokeGeometry, ctx, ...scale(local.strokeGeometry));
    if (fill.length) out.fillGeometry = fill;
    if (stroke.length) out.strokeGeometry = stroke;
  }
  const ia = interactions(local);
  if (ia.length) out.interactions = ia;

  if (type === "TEXT") {
    const chars: string = local.textData?.characters ?? "";
    out.characters = chars;
    out.style = textStyle(local);
    // where Figma broke the lines (not in REST): the renderer breaks there too, whatever the browser's glyph widths
    const lines: NC[] | undefined = local.derivedTextData?.baselines;
    const last = lines?.[lines.length - 1];
    if (lines?.length && last && last.endCharacter === chars.length) out.lineStarts = lines.map((l) => l.firstCharacter ?? 0);
    const ids: number[] = Array.from(local.textData?.characterStyleIDs ?? []);
    if (ids.some((x) => x !== 0)) {
      out.characterStyleOverrides = ids;
      out.styleOverrideTable = Object.fromEntries((local.textData?.styleOverrideTable ?? []).map((o: NC) => [String(o.styleID), runStyle(ctx, o, out.style.fontSize)]));
    }
  }

  if (local.type === "INSTANCE") {
    const symbolId = gid(local.overriddenSymbolID ?? local.symbolData?.symbolID);
    if (symbolId) out.componentId = symbolId;
    out.children = expandInstance(local, id, ctx, m, ov);
  } else {
    const inner = type === "GROUP" || type === "BOOLEAN_OPERATION" ? container : m;
    out.children = (ctx.kids.get(gid(n.guid)) ?? []).map((c) => convert(c, ctx, m, inner, prefix, ov));
  }
  if (!out.children.length) delete out.children;
  return out;
}

// ---------------------------------------------------------------- instances

/**
 * Overrides of one instance, keyed by the path of the node they apply to: a symbolOverride / derivedSymbolData entry
 * names its node with guidPath = the overrideKeys (or guids) of the nested instances down to the node.
 */
type Overrides = { get(n: NC): NC | undefined; scope: Map<string, NC> };
const keyOf = (n: NC) => gid(n.overrideKey ?? n.guid);
const pathOf = (o: NC) => ((o.guidPath?.guids ?? []) as Guid[]).map(gid).join("/");
const strip = (o: NC): NC => {
  const { guidPath: _p, guid: _g, ...rest } = o;
  return rest;
};

/** Patch b applied over patch a: a style bound without its paints drops the paints of a (they are of another style). */
function mergePatch(a: NC | undefined, b: NC): NC {
  if (!a) return { ...b };
  const out: NC = { ...a, ...b };
  if (b.styleIdForFill && !b.fillPaints) delete out.fillPaints;
  if (b.styleIdForStrokeFill && !b.strokePaints) delete out.strokePaints;
  if (b.styleIdForText && !b.fontName && !b.fontSize) for (const k of TEXT_STYLE_FIELDS) if (!(k in b)) delete out[k];
  if (Array.isArray(a.componentPropAssignments) && Array.isArray(b.componentPropAssignments)) {
    const byDef = new Map<string, NC>();
    for (const x of [...a.componentPropAssignments, ...b.componentPropAssignments]) byDef.set(gid(x.defID), x);
    out.componentPropAssignments = [...byDef.values()];
  }
  return out;
}

function expandInstance(inst: NC, instId: string, ctx: Ctx, m: M, outer?: Overrides): AnyNode[] {
  const symbolId = gid(inst.overriddenSymbolID ?? inst.symbolData?.symbolID);
  if (!ctx.byId.get(symbolId)) return [];
  const scope = new Map<string, NC>();
  const add = (p: string, patch: NC) => { if (p) scope.set(p, mergePatch(scope.get(p), patch)); };
  // the instance's own data first: its overrides, then its derived data (sizes and places after auto layout and
  // constraints: an override size can be stale, e.g. 32 for an icon laid out at 48); overrides of outer instances that
  // reach inside this one (their path goes through it) are applied last: the outermost instance wins
  for (const o of inst.symbolData?.symbolOverrides ?? []) add(pathOf(o), strip(o));
  for (const o of inst.derivedSymbolData ?? []) add(pathOf(o), strip(o));
  const own = keyOf(inst);
  if (outer) for (const [p, patch] of outer.scope) if (p.startsWith(own + "/")) add(p.slice(own.length + 1), patch);

  // component properties: text, visibility, instance swap of the nodes that reference them
  const assigned = new Map<string, NC>();
  for (const a of inst.componentPropAssignments ?? []) assigned.set(gid(a.defID), a.value ?? {});

  const overrides: Overrides = {
    scope,
    get(n: NC) {
      const base = scope.get(keyOf(n));
      const patch: NC = base ? { ...base } : {};
      for (const ref of n.componentPropRefs ?? []) {
        if (ref.isDeleted) continue;
        const v = assigned.get(gid(ref.defID));
        if (!v) continue;
        const field = ref.componentPropNodeField;
        if (field === "TEXT_DATA" && v.textValue) patch.textData = v.textValue;
        else if (field === "VISIBLE" && v.boolValue !== undefined) patch.visible = v.boolValue;
        else if (field === "OVERRIDDEN_SYMBOL_ID" && v.guidValue) patch.overriddenSymbolID = v.guidValue;
      }
      return Object.keys(patch).length ? patch : undefined;
    },
  };
  // the instance's own frame is placed by its transform; its children keep the component's relative layout
  const prefix = `I${instId.replace(/^I/, "")};`;
  return (ctx.kids.get(symbolId) ?? []).map((c) => convert(c, ctx, m, m, prefix, overrides));
}
