/**
 * REST-shaped frame → DesignSpec: what the compare engine checks, read like the image of the frame shows it
 * (area.ts): only the design area; a node hidden, or clipped away by a frame that clips its content or by a mask,
 * is left out; a fixed child of a frame that scrolls stays on its screen and comes after the content that scrolls.
 * Rules kept from the earlier extractor:
 *   - a padding / stroke field missing in the JSON means 0 (not "same as the opposite side")
 *   - the text style is the one of the TEXT node itself (`style`), never the shared text style
 *   - a GROUP (or a frame without paint) takes the visual of the background rectangle that covers it
 */
import type { Box } from "@figtest/contracts";
import { designArea, designFrame, overlaps } from "./area";
import type { DesignLayout, DesignNode, DesignSpec, DesignText, DesignVisual, TextCase } from "./spec-types";
import type { DesignDocument, DesignFrame } from "./types";
import { type AnyNode, type Rect, boxOf, childrenOf, r2, solidHex, visiblePaints } from "./util";

const CASES: Record<string, TextCase> = { UPPER: "upper", LOWER: "lower", TITLE: "title", SMALL_CAPS: "small-caps", SMALL_CAPS_FORCED: "small-caps" };
const ALIGN = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" } as const;
const AUTO_RESIZE = new Set(["WIDTH_AND_HEIGHT", "HEIGHT", "NONE", "TRUNCATE"]);
const BREAKS = new RegExp(`\\r\\n?|[\\n${String.fromCharCode(0x2028, 0x2029)}]`);

function textOf(node: AnyNode, box: Box): DesignText {
  const st: AnyNode = node.style ?? {};
  const fontSize = Number(st.fontSize ?? 16);
  // "auto" line height (lineHeightUnit INTRINSIC_%) has the rendered value in lineHeightPx too
  const lineHeight = st.lineHeightPx == null ? null : r2(Number(st.lineHeightPx));
  const characters: string = node.characters ?? "";
  const overrides: number[] = Array.isArray(node.characterStyleOverrides) ? node.characterStyleOverrides : [];
  const lineBox = lineHeight || fontSize * 1.2;
  const autoResize = String(st.textAutoResize ?? node.textAutoResize ?? "NONE");
  return {
    characters,
    paragraphs: characters.split(BREAKS).map((s) => s.trim()).filter(Boolean),
    fontFamily: String(st.fontFamily ?? ""),
    fontWeight: Number(st.fontWeight ?? 400),
    fontSize,
    lineHeight,
    lineHeightAuto: st.lineHeightUnit === "INTRINSIC_%",
    letterSpacing: r2(Number(st.letterSpacing ?? 0)),
    color: solidHex(node.fills),
    decoration: st.textDecoration === "UNDERLINE" ? "underline" : st.textDecoration === "STRIKETHROUGH" ? "line-through" : "none",
    textCase: CASES[String(st.textCase)] ?? "none",
    align: ALIGN[st.textAlignHorizontal as keyof typeof ALIGN] ?? "left",
    autoResize: (AUTO_RESIZE.has(autoResize) ? autoResize : "NONE") as DesignText["autoResize"],
    lines: Array.isArray(node.lineStarts) && node.lineStarts.length ? node.lineStarts.length : Math.max(1, Math.round(box.h / lineBox)),
    mixed: overrides.some((o) => o !== 0) && Object.keys(node.styleOverrideTable ?? {}).length > 0,
  };
}

function layoutOf(node: AnyNode): DesignLayout | undefined {
  if (node.layoutMode !== "HORIZONTAL" && node.layoutMode !== "VERTICAL") return undefined;
  const layout: DesignLayout = {
    mode: node.layoutMode,
    gap: Number(node.itemSpacing ?? 0),
    padding: { t: Number(node.paddingTop ?? 0), r: Number(node.paddingRight ?? 0), b: Number(node.paddingBottom ?? 0), l: Number(node.paddingLeft ?? 0) },
  };
  if (node.primaryAxisAlignItems) layout.primaryAlign = String(node.primaryAxisAlignItems);
  if (node.counterAxisAlignItems) layout.counterAlign = String(node.counterAxisAlignItems);
  if (node.layoutWrap === "WRAP") layout.wrap = true;
  return layout;
}

function visualOf(node: AnyNode): DesignVisual | undefined {
  const fills = visiblePaints(node.fills);
  const stroke = solidHex(node.strokes);
  const weight = Number(node.strokeWeight ?? 0);
  const radius = typeof node.cornerRadius === "number" ? node.cornerRadius
    : Array.isArray(node.rectangleCornerRadii) ? Number(node.rectangleCornerRadii[0] ?? 0) : null;
  const effects = (Array.isArray(node.effects) ? node.effects : []).filter((e: AnyNode) => e.visible !== false);
  const v: DesignVisual = {
    fill: solidHex(fills),
    gradient: fills.some((p) => String(p.type).startsWith("GRADIENT")),
    image: fills.some((p) => p.type === "IMAGE"),
    stroke: stroke && weight > 0 ? { color: stroke, weight } : null,
    radius: radius ? r2(radius) : null,
    opacity: r2(Number(node.opacity ?? 1)),
    shadow: effects.some((e: AnyNode) => e.type === "DROP_SHADOW"),
  };
  return v.fill || v.gradient || v.image || v.stroke || v.radius || v.shadow || v.opacity < 1 ? v : undefined;
}

function componentName(doc: DesignDocument, node: AnyNode): string | null {
  const c = typeof node.componentId === "string" ? doc.components?.[node.componentId] : undefined;
  if (!c) return null;
  const set = c.componentSetId ? doc.componentSets?.[c.componentSetId] : undefined;
  return set ? `${set.name} / ${c.name}` : c.name;
}

const intersect = (a: Rect | null, b: Rect): Rect => {
  if (!a) return b;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
};

const CONTAINERS = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SECTION"]);

/** The spec of a frame: its design area only (what the image shows). */
export function extractSpec(doc: DesignDocument, frame: DesignFrame): DesignSpec {
  const raw = frame.node as AnyNode;
  const origin = boxOf(raw);
  if (!origin) throw new Error(`Frame ${frame.nodeId} has no absoluteBoundingBox`);
  const view = designFrame(raw);
  const nodes: DesignNode[] = [];
  const byId = new Map<string, DesignNode>();

  const walk = (node: AnyNode, parent: string | null, depth: number, clip: Rect | null) => {
    if (node.visible === false) return;
    const bb = boxOf(node);
    if (!bb || (clip && !overlaps(node, clip))) return;
    const isRoot = node === view;
    const src = isRoot ? raw : node;
    const box: Box = { x: r2(bb.x - origin.x), y: r2(bb.y - origin.y), w: r2(src.absoluteBoundingBox.width), h: r2(src.absoluteBoundingBox.height) };
    const out: DesignNode = { id: String(node.id), name: String(node.name ?? ""), type: String(node.type), parent, depth, box, children: [] };
    if (node.type === "INSTANCE") out.component = componentName(doc, node);
    if (node.type === "TEXT") out.text = textOf(node, box);
    const layout = layoutOf(node);
    if (layout) out.layout = layout;
    if (node.type !== "TEXT") {
      const visual = visualOf(node);
      if (visual) out.visual = visual;
    }
    nodes.push(out);
    byId.set(out.id, out);

    // what the children may show in: the design area for the frame, the box of a frame that clips its content
    let inner = isRoot ? designArea(raw) : node.clipsContent === true ? intersect(clip, bb) : clip;
    for (const child of childrenOf(node)) {
      if (child.visible === false) continue;
      // a mask is not drawn: it clips the siblings above it (to its box)
      if (child.isMask) {
        const mb = boxOf(child);
        if (mb) inner = intersect(inner, mb);
        continue;
      }
      const before = nodes.length;
      walk(child, out.id, depth + 1, inner);
      if (nodes.length > before) out.children.push(String(child.id));
    }
    // a group has no paint of its own: the background rectangle that covers it gives it
    if (CONTAINERS.has(String(node.type)) && !out.visual) {
      const bg = out.children.map((id) => byId.get(id)).find((c) =>
        c && (c.type === "RECTANGLE" || c.type === "FRAME") && c.visual && !c.text && c.box.w * c.box.h >= 0.95 * box.w * box.h);
      if (bg?.visual) out.visual = { ...bg.visual, fromChild: bg.id };
    }
  };
  walk(view, null, 0, null);

  return {
    schema: 1,
    frameId: frame.nodeId,
    frameName: frame.name,
    size: { w: frame.viewport.w, h: frame.designHeight },
    viewport: { ...frame.viewport },
    nodes,
  };
}
