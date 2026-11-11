/**
 * The design area of a frame: what of it is its design, like Figma shows it. The spec (spec.ts) and the image
 * (render.ts) take the same part, so a text of the spec is a text of the image.
 *   - a frame without "Clip content" (clipsContent false) goes down to the bottom of its visible content
 *   - a frame that scrolls vertically in the prototype (overflowDirection *VERTICAL*) is one screen high in Figma, its
 *     content goes on below it: the design goes down to the bottom of the content that scrolls. A child that stays on
 *     the screen while it scrolls (scrollBehavior FIXED: a bottom menu, a floating button) stays where it is in the
 *     frame, like position: fixed in a screenshot of the website, and is drawn above the content that scrolls
 *   - any other frame clips its content to its box
 * At most MAX_HEIGHT (Chromium takes screenshots up to 16384 px high).
 */
import { type AnyNode, type Rect, boxOf, childrenOf } from "./util";

export const MAX_HEIGHT = 16000;

/** A child that stays on the screen while its frame scrolls (REST scrollBehavior FIXED; isFixed in older files). */
export const isFixed = (n: AnyNode) => n.scrollBehavior === "FIXED" || n.isFixed === true;

/** The frame clips its content and scrolls vertically in the prototype. */
export const scrollsDown = (frame: AnyNode) => frame.clipsContent !== false && /VERTICAL/.test(String(frame.overflowDirection ?? ""));

const shown = (n: AnyNode) => n.visible !== false;

/** Bottom (absolute y) of the visible content of these nodes, down into the ones that do not clip. */
function contentBottom(nodes: AnyNode[], from: number): number {
  let bottom = from;
  const walk = (list: AnyNode[]) => {
    for (const c of list) {
      const b = boxOf(c);
      if (!shown(c) || !b) continue;
      bottom = Math.max(bottom, b.y + b.height);
      if (c.clipsContent !== true) walk(childrenOf(c));
    }
  };
  walk(nodes);
  return bottom;
}

/** Height of the design of a frame in whole pixels (a screenshot viewport takes integers), at most MAX_HEIGHT. */
export function designHeight(frame: AnyNode): number {
  const b = boxOf(frame);
  if (!b) return 0;
  const kids = childrenOf(frame).filter(shown);
  const bottom = frame.clipsContent === false ? contentBottom(kids, b.y + b.height)
    : scrollsDown(frame) ? contentBottom(kids.filter((c) => !isFixed(c)), b.y + b.height)
      : b.y + b.height;
  return Math.max(1, Math.min(Math.ceil(bottom - b.y - 0.01), MAX_HEIGHT));
}

/** Width of the design (and of its image / viewport): the frame width in whole pixels. */
export const designWidth = (frame: AnyNode) => Math.max(1, Math.round(boxOf(frame)?.width ?? 1));

/** The design area in absolute coordinates: the frame box down to its design height. */
export function designArea(frame: AnyNode): Rect {
  const b = boxOf(frame) ?? { x: 0, y: 0, width: 0, height: 0 };
  return { x: b.x, y: b.y, width: designWidth(frame), height: designHeight(frame) };
}

/** The box overlaps the area (a node without a box is kept). */
export function overlaps(n: AnyNode, area: Rect | null): boolean {
  const b = boxOf(n);
  if (!area || !b) return true;
  const x2 = area.x + area.width, y2 = area.y + area.height;
  // a line has no height (or width): it shows when it is inside the area, edges included
  const ox = b.width > 0 ? b.x < x2 && b.x + b.width > area.x : b.x >= area.x && b.x <= x2;
  const oy = b.height > 0 ? b.y < y2 && b.y + b.height > area.y : b.y >= area.y && b.y <= y2;
  return ox && oy;
}

/**
 * The children of a frame in its design, in drawing order: the visible ones in its design area (a frame without clip
 * content shows them all); of a frame that scrolls, the fixed ones only when they are on its screen (its box: one
 * placed below it never shows), after the others.
 */
export function shownChildren(frame: AnyNode): AnyNode[] {
  const area = frame.clipsContent === false ? null : designArea(frame);
  const kids = childrenOf(frame).filter((c) => shown(c) && overlaps(c, area));
  if (!scrollsDown(frame)) return kids;
  const screen = boxOf(frame);
  return [...kids.filter((c) => !isFixed(c)), ...kids.filter((c) => isFixed(c) && overlaps(c, screen))];
}

/**
 * The frame as its design shows it: its box down to the design height, clipping it (a frame without clip content
 * shows everything: the area is wide enough for its content below, nothing else is cut), and the children shown.
 */
export function designFrame(frame: AnyNode): AnyNode {
  const b = boxOf(frame) ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    ...frame,
    absoluteBoundingBox: { x: b.x, y: b.y, width: designWidth(frame), height: designHeight(frame) },
    children: shownChildren(frame),
    clipsContent: true,
  };
}

/** Viewport of the test: frame width × (scrolls ? frame height : design height), at most MAX_HEIGHT high. */
export function designViewport(frame: AnyNode): { w: number; h: number } {
  const b = boxOf(frame);
  const h = scrollsDown(frame) ? Math.max(1, Math.round(b?.height ?? 1)) : designHeight(frame);
  return { w: designWidth(frame), h: Math.min(h, MAX_HEIGHT) };
}
