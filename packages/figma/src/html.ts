/**
 * A frame as HTML: every visible node is an absolutely positioned box inside the box of its parent, with its fills
 * (solid, image with its scale mode, linear / radial / angular gradients), strokes (inside / center / outside, per
 * side, dashed), corner radius, opacity, blend mode, shadows and blurs, and text (runs of other styles, Figma's line
 * breaks when known). The design area only (area.ts): what the spec reads is what the image shows.
 *   - a rotated or flipped node is drawn in its own size, turned around the center of its box (its absolute
 *     transform: the relativeTransforms of its containers composed; groups are not containers)
 *   - clipping like Figma: a frame with clipsContent hides what overflows it (rounded by its corners); a mask clips
 *     the siblings above it to its outline (its vector path when it has one), the mask itself is not drawn
 *   - vectors (icons) are SVG paths of their fillGeometry / strokeGeometry (fig.ts, or REST ?geometry=paths)
 * Not drawn: image paints of vectors, image filters, the alpha of a gradient / image mask, text on a path.
 */
import { designFrame } from "./area";
import { type AnyNode, boxOf, childrenOf, visiblePaints } from "./util";

/** families → "italic,weight" pairs used by the texts */
export type FontUse = Map<string, Set<string>>;

export type FrameHtml = {
  /** the body: <div id="f"> with the frame */
  body: string;
  width: number;
  height: number;
  fonts: FontUse;
  images: Set<string>;
};

type Lin = [number, number, number, number]; // CSS matrix(a, b, c, d): x' = a x + c y, y' = b x + d y
const ID: Lin = [1, 0, 0, 1];
const mulLin = (p: Lin, q: Lin): Lin => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3]];
const isId = (l: Lin) => Math.abs(l[0] - 1) < 1e-3 && Math.abs(l[1]) < 1e-3 && Math.abs(l[2]) < 1e-3 && Math.abs(l[3] - 1) < 1e-3;
function linOf(n: AnyNode): Lin {
  const t = n.relativeTransform;
  if (!Array.isArray(t) || !Array.isArray(t[0]) || !Array.isArray(t[1])) return ID;
  return [Number(t[0][0] ?? 1), Number(t[1][0] ?? 0), Number(t[0][1] ?? 0), Number(t[1][1] ?? 1)];
}
const NOT_CONTAINERS = new Set(["GROUP", "BOOLEAN_OPERATION"]);
const VECTORS = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "LINE", "ELLIPSE"]);

const n2 = (v: number) => Math.round(v * 100) / 100;
const px = (v: number) => `${n2(v)}px`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const cssColor = (c: AnyNode | undefined, opacity = 1) =>
  c ? `rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${n2((c.a ?? 1) * opacity * 1000) / 1000})` : "transparent";

const BLEND: Record<string, string> = {
  MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference", EXCLUSION: "exclusion",
  HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};

// ---------------------------------------------------------------- paints

type Pt = { x: number; y: number };
const handles = (p: AnyNode): [Pt, Pt, Pt] => {
  const h = Array.isArray(p.gradientHandlePositions) ? p.gradientHandlePositions : [];
  return [h[0] ?? { x: 0.5, y: 0 }, h[1] ?? { x: 0.5, y: 1 }, h[2] ?? { x: 0, y: 0 }];
};
const stopsOf = (p: AnyNode): AnyNode[] => (Array.isArray(p.gradientStops) ? p.gradientStops : []);

/** CSS gradient of a gradient paint on a w × h box (Figma's handles mapped onto the CSS gradient line). */
function cssGradient(p: AnyNode, w: number, h: number): string | null {
  const stops = stopsOf(p);
  if (!stops.length) return null;
  const op = p.opacity ?? 1;
  const [s0, e0, w0] = handles(p);
  const S = { x: s0.x * w, y: s0.y * h }, E = { x: e0.x * w, y: e0.y * h }, W = { x: w0.x * w, y: w0.y * h };
  if (p.type === "GRADIENT_LINEAR") {
    const dx = E.x - S.x, dy = E.y - S.y;
    if (!dx && !dy) return null;
    const angle = Math.atan2(dx, -dy); // CSS: 0deg = to top, clockwise
    const u = { x: Math.sin(angle), y: -Math.cos(angle) };
    const L = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle)) || 1;
    const cx = w / 2, cy = h / 2;
    const at = (t: number) => {
      const P = { x: S.x + t * dx, y: S.y + t * dy };
      return (((P.x - cx) * u.x + (P.y - cy) * u.y + L / 2) / L) * 100;
    };
    return `linear-gradient(${n2((angle * 180) / Math.PI)}deg,${stops.map((s) => `${cssColor(s.color, op)} ${n2(at(s.position ?? 0))}%`).join(",")})`;
  }
  const list = stops.map((s) => `${cssColor(s.color, op)} ${n2((s.position ?? 0) * 100)}%`).join(",");
  if (p.type === "GRADIENT_ANGULAR") {
    const from = (Math.atan2(E.x - S.x, -(E.y - S.y)) * 180) / Math.PI;
    return `conic-gradient(from ${n2(from)}deg at ${px(S.x)} ${px(S.y)},${stops.map((s) => `${cssColor(s.color, op)} ${n2((s.position ?? 0) * 360)}deg`).join(",")})`;
  }
  // radial and diamond: an ellipse with the two radii of the handles (its rotation left out)
  const rx = Math.hypot(E.x - S.x, E.y - S.y) || 1, ry = Math.hypot(W.x - S.x, W.y - S.y) || rx;
  return `radial-gradient(${px(rx)} ${px(ry)} at ${px(S.x)} ${px(S.y)},${list})`;
}

/** CSS background layer of an image paint on a w × h box. */
function imageLayer(p: AnyNode, w: number, h: number): string {
  const url = `url('/img/${encodeURIComponent(String(p.imageRef))}')`;
  if (p.scaleMode === "FIT") return `${url} center/contain no-repeat`;
  if (p.scaleMode === "TILE") {
    const size = p.originalImageSize?.width && p.scalingFactor ? `${px(p.originalImageSize.width * p.scalingFactor)} auto` : p.scalingFactor ? `${n2(p.scalingFactor * 100)}%` : "auto";
    return `${url} 0 0/${size} repeat`;
  }
  if (p.scaleMode === "STRETCH") {
    // crop: imageTransform maps the unit square of the node to the part of the image shown (rotation left out)
    const t = p.imageTransform;
    const a = Number(t?.[0]?.[0]), d = Number(t?.[1]?.[1]);
    if (!a || !d) return `${url} 0 0/100% 100% no-repeat`;
    const sx = w / a, sy = h / d;
    return `${url} ${px(-Number(t[0][2] ?? 0) * sx)} ${px(-Number(t[1][2] ?? 0) * sy)}/${px(sx)} ${px(sy)} no-repeat`;
  }
  return `${url} center/cover no-repeat`; // FILL
}

/** background of the fills (CSS: first layer on top; Figma: last paint on top), + image paints that need a layer */
function background(fills: AnyNode[], w: number, h: number, images: Set<string>): { css: string; layers: string } {
  const out: string[] = [];
  let layers = "";
  for (const p of [...fills].reverse()) {
    if (p.type === "SOLID") out.push(`linear-gradient(${cssColor(p.color, p.opacity ?? 1)},${cssColor(p.color, p.opacity ?? 1)})`);
    else if (String(p.type).startsWith("GRADIENT")) {
      const g = cssGradient(p, w, h);
      if (g) out.push(g);
    } else if (p.type === "IMAGE" && p.imageRef) {
      images.add(String(p.imageRef));
      if ((p.opacity ?? 1) < 1 || (p.blendMode && p.blendMode !== "NORMAL" && BLEND[p.blendMode])) {
        // an image paint with its own opacity / blend mode: a layer of its own, above the paints below it
        layers += `<div style="left:0;top:0;width:100%;height:100%;border-radius:inherit;background:${imageLayer(p, w, h)};opacity:${n2(p.opacity ?? 1)};${BLEND[p.blendMode] ? `mix-blend-mode:${BLEND[p.blendMode]};` : ""}"></div>`;
      } else out.push(imageLayer(p, w, h));
    }
  }
  return { css: out.length ? `background:${out.join(",")};` : "", layers };
}

/** color of the topmost visible solid paint (or first stop of a gradient), CSS */
function paintColor(paints: AnyNode[]): string | null {
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i]!;
    if (p.type === "SOLID") return cssColor(p.color, p.opacity ?? 1);
    if (String(p.type).startsWith("GRADIENT") && stopsOf(p).length) return cssColor(stopsOf(p)[0]!.color, p.opacity ?? 1);
  }
  return null;
}

function radiusOf(n: AnyNode): { css: string; px: number | null } {
  if (n.type === "ELLIPSE") return { css: "border-radius:50%;", px: null };
  if (Array.isArray(n.rectangleCornerRadii) && n.rectangleCornerRadii.some((r: number) => r)) {
    return { css: `border-radius:${n.rectangleCornerRadii.map((r: number) => px(Number(r) || 0)).join(" ")};`, px: Number(n.rectangleCornerRadii[0]) || 0 };
  }
  return n.cornerRadius ? { css: `border-radius:${px(n.cornerRadius)};`, px: Number(n.cornerRadius) } : { css: "", px: 0 };
}

type Effects = { boxShadow: string[]; dropFilter: string[]; filter: string[]; backdrop: string; textShadow: string[] };
function effectsOf(n: AnyNode): Effects {
  const fx: Effects = { boxShadow: [], dropFilter: [], filter: [], backdrop: "", textShadow: [] };
  for (const e of Array.isArray(n.effects) ? n.effects : []) {
    if (e.visible === false) continue;
    const x = Number(e.offset?.x ?? 0), y = Number(e.offset?.y ?? 0), r = Number(e.radius ?? 0), s = Number(e.spread ?? 0);
    const color = cssColor(e.color);
    if (e.type === "DROP_SHADOW") {
      fx.boxShadow.push(`${px(x)} ${px(y)} ${px(r)} ${px(s)} ${color}`);
      fx.dropFilter.push(`drop-shadow(${px(x)} ${px(y)} ${px(r / 2)} ${color})`);
      fx.textShadow.push(`${px(x)} ${px(y)} ${px(r)} ${color}`);
    } else if (e.type === "INNER_SHADOW") {
      fx.boxShadow.push(`inset ${px(x)} ${px(y)} ${px(r)} ${px(s)} ${color}`);
    } else if (e.type === "LAYER_BLUR" || e.type === "FOREGROUND_BLUR") {
      fx.filter.push(`blur(${px(r / 2)})`);
    } else if (e.type === "BACKGROUND_BLUR") {
      fx.backdrop = `backdrop-filter:blur(${px(r / 2)});`;
    }
  }
  return fx;
}

/** border box drawn above the content: inside, centered on or outside the edge of the node, per side */
function strokeOverlay(n: AnyNode, strokes: AnyNode[], radius: { css: string; px: number | null }): string {
  const color = paintColor(strokes);
  const weight = Number(n.strokeWeight ?? 0);
  const ind = n.individualStrokeWeights;
  const t = ind ? Number(ind.top ?? 0) : weight, r = ind ? Number(ind.right ?? 0) : weight;
  const b = ind ? Number(ind.bottom ?? 0) : weight, l = ind ? Number(ind.left ?? 0) : weight;
  if (!color || !(t || r || b || l)) return "";
  const k = n.strokeAlign === "OUTSIDE" ? 1 : n.strokeAlign === "CENTER" ? 0.5 : 0;
  const dashed = Array.isArray(n.strokeDashes) && n.strokeDashes.length ? "dashed" : "solid";
  const round = radius.px === null ? "border-radius:50%;" : radius.px ? radius.css.replace(/(-?[\d.]+)px/g, (_m, v: string) => px(Number(v) + (Number(v) ? k * weight : 0))) : "";
  return `<div style="left:${px(-k * l)};top:${px(-k * t)};right:${px(-k * r)};bottom:${px(-k * b)};border-style:${dashed};border-color:${color};`
    + `border-width:${px(t)} ${px(r)} ${px(b)} ${px(l)};${round}"></div>`;
}

// ---------------------------------------------------------------- text

const BREAKS = new RegExp(`\\r\\n?|[\\n${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const CJK = /[぀-ヿ㐀-鿿豈-﫿＀-￯]/;
const CJK_FAMILY = /noto\s*(sans|serif)\s*(jp|cjk|sc|tc|kr)|hiragino|ヒラギノ|gothic|ゴシック|mincho|明朝|meiryo|メイリオ|osaka|m\s*plus|biz\s*ud|zen\s/i;

/** a family Google Fonts does not have: the one that looks like it (also loaded) */
export function fontAlias(family: string): string | null {
  if (/hiragino|ヒラギノ|yu\s*gothic|游ゴシック|meiryo|メイリオ|ms\s*p?gothic|ｍｓ|osaka/i.test(family)) return "Noto Sans JP";
  if (/mincho|明朝/i.test(family)) return "Noto Serif JP";
  if (/^(sf\s*pro|sf\s*ui|san\s*francisco|-apple-system|system-ui|helvetica)/i.test(family)) return "Inter";
  if (/^avenir/i.test(family)) return "Nunito Sans";
  return null;
}

function fontStack(family: string, text: string, fonts: FontUse, weight: number, italic: boolean): string {
  const list = [family];
  const alias = fontAlias(family);
  if (alias) list.push(alias);
  // Figma draws the characters a font does not have (Japanese in a Latin font) with its fallback font
  if (CJK.test(text) && !CJK_FAMILY.test(family) && alias !== "Noto Sans JP") list.push("Noto Sans JP");
  const pair = `${italic ? 1 : 0},${weight}`;
  for (const f of list) {
    if (!f) continue;
    let set = fonts.get(f);
    if (!set) fonts.set(f, (set = new Set()));
    set.add(pair);
  }
  return `${list.filter(Boolean).map((f) => `'${f.replace(/'/g, "\\'")}'`).join(",")},sans-serif`;
}

const CASE: Record<string, string> = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };
const DECO: Record<string, string> = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };

function runCss(o: AnyNode, base: AnyNode, text: string, fonts: FontUse): string {
  let s = "";
  const family = o.fontFamily ?? base.fontFamily ?? "";
  const weight = Number(o.fontWeight ?? base.fontWeight ?? 400);
  const italic = !!(o.italic ?? base.italic);
  if (o.fontFamily || o.fontWeight || o.italic !== undefined) s += `font-family:${fontStack(family, text, fonts, weight, italic)};font-weight:${weight};`;
  if (o.italic !== undefined) s += `font-style:${o.italic ? "italic" : "normal"};`;
  if (o.fontSize) s += `font-size:${px(o.fontSize)};`;
  if (o.letterSpacing !== undefined) s += `letter-spacing:${px(o.letterSpacing)};`;
  if (Array.isArray(o.fills)) {
    const c = paintColor(visiblePaints(o.fills));
    if (c) s += `color:${c};`;
  }
  if (o.textDecoration) s += `text-decoration:${DECO[o.textDecoration] ?? "none"};`;
  if (o.textCase && CASE[o.textCase]) s += `text-transform:${CASE[o.textCase]};`;
  return s;
}

/**
 * The text of a TEXT node as HTML: its runs of other styles as spans, and its lines: U+2028 / U+2029 (Shift+Enter in
 * Figma) are breaks; with lineStarts, one line per laid out Figma line (the spaces where Figma wrapped are dropped).
 */
function textContent(n: AnyNode, fonts: FontUse): string {
  const chars: string = String(n.characters ?? "");
  const starts: number[] | null = Array.isArray(n.lineStarts) && n.lineStarts.length ? n.lineStarts : null;
  const ranges: [number, number][] = starts
    ? starts.map((at, i) => {
      let end = starts[i + 1] ?? chars.length;
      while (end > at && /\s/.test(chars[end - 1]!)) end--;
      return [at, end];
    })
    : [[0, chars.length]];
  const ids: number[] = Array.isArray(n.characterStyleOverrides) ? n.characterStyleOverrides : [];
  const table: AnyNode = n.styleOverrideTable ?? {};
  const base: AnyNode = n.style ?? {};
  const piece = (from: number, to: number) => esc(chars.slice(from, to)).replace(BREAKS, "\n");
  const lines = ranges.map(([from, to]) => {
    if (!ids.length) return piece(from, to);
    let html = "";
    for (let i = from; i < to;) {
      const id = ids[i] ?? 0;
      let j = i + 1;
      while (j < to && (ids[j] ?? 0) === id) j++;
      const o = id ? table[String(id)] : undefined;
      const css = o ? runCss(o, base, chars.slice(i, j), fonts) : "";
      html += css ? `<span style="${css}">${piece(i, j)}</span>` : piece(i, j);
      i = j;
    }
    return html;
  });
  return lines.join("\n");
}

function textCss(n: AnyNode, fonts: FontUse): string {
  const s: AnyNode = n.style ?? {};
  const weight = Number(s.fontWeight ?? 400);
  const color = paintColor(visiblePaints(n.fills));
  const fx = effectsOf(n);
  const vAlign = s.textAlignVertical === "CENTER" ? "center" : s.textAlignVertical === "BOTTOM" ? "flex-end" : "flex-start";
  const nowrap = (Array.isArray(n.lineStarts) && n.lineStarts.length) || s.textAutoResize === "WIDTH_AND_HEIGHT";
  return `font-family:${fontStack(String(s.fontFamily ?? ""), String(n.characters ?? ""), fonts, weight, !!s.italic)};`
    + `font-size:${px(Number(s.fontSize ?? 16))};font-weight:${weight};`
    + (s.italic ? "font-style:italic;" : "")
    + (s.lineHeightPx ? `line-height:${px(s.lineHeightPx)};` : "")
    + `letter-spacing:${px(Number(s.letterSpacing ?? 0))};`
    + `text-align:${String(s.textAlignHorizontal ?? "LEFT").toLowerCase().replace("justified", "justify")};`
    + (color ? `color:${color};` : "color:transparent;")
    + (CASE[s.textCase] ? `text-transform:${CASE[s.textCase]};` : "")
    + (DECO[s.textDecoration] ? `text-decoration:${DECO[s.textDecoration]};` : "")
    + (fx.textShadow.length ? `text-shadow:${fx.textShadow.join(",")};` : "")
    + (fx.filter.length ? `filter:${fx.filter.join(" ")};` : "")
    + `display:flex;flex-direction:column;justify-content:${vAlign};`
    + (s.textTruncation === "ENDING" ? "overflow:hidden;" : "")
    // the lines of Figma when known, and an auto-width text never wraps: the browser's glyphs may be a bit wider
    + (nowrap ? "white-space:pre;" : "white-space:pre-wrap;overflow-wrap:break-word;");
}

// ---------------------------------------------------------------- vectors

let gradientIds = 0;
function svgPaint(p: AnyNode, w: number, h: number, defs: string[]): string | null {
  if (p.type === "SOLID") return cssColor(p.color, p.opacity ?? 1);
  if (!String(p.type).startsWith("GRADIENT") || !stopsOf(p).length) return null;
  const id = `g${++gradientIds}`;
  const [s, e, wh] = handles(p);
  const stops = stopsOf(p).map((st) => `<stop offset="${n2(st.position ?? 0)}" stop-color="${cssColor(st.color, p.opacity ?? 1)}"/>`).join("");
  if (p.type === "GRADIENT_LINEAR") {
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n2(s.x * w)}" y1="${n2(s.y * h)}" x2="${n2(e.x * w)}" y2="${n2(e.y * h)}">${stops}</linearGradient>`);
  } else {
    const r = Math.hypot((e.x - s.x) * w, (e.y - s.y) * h) || 1;
    const ry = Math.hypot((wh.x - s.x) * w, (wh.y - s.y) * h) || r;
    defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n2(s.x * w)}" cy="${n2(s.y * h)}" r="${n2(r)}" gradientTransform="translate(${n2(s.x * w)} ${n2(s.y * h)}) scale(1 ${n2(ry / r)}) translate(${n2(-s.x * w)} ${n2(-s.y * h)})">${stops}</radialGradient>`);
  }
  return `url(#${id})`;
}

/** a vector node as an SVG: its fill paths with each paint, then the outline of its stroke */
function vectorSvg(n: AnyNode, w: number, h: number): string {
  const defs: string[] = [];
  const paths: string[] = [];
  const geo = (list: unknown) => (Array.isArray(list) ? list.filter((g: AnyNode) => typeof g?.path === "string" && g.path) : []);
  const fills = geo(n.fillGeometry), strokes = geo(n.strokeGeometry);
  for (const p of visiblePaints(n.fills)) {
    const paint = svgPaint(p, w, h, defs);
    if (paint) for (const g of fills) paths.push(`<path d="${esc(g.path)}" fill="${paint}" fill-rule="${g.windingRule === "EVENODD" ? "evenodd" : "nonzero"}"/>`);
  }
  for (const p of visiblePaints(n.strokes)) {
    const paint = svgPaint(p, w, h, defs);
    if (paint) for (const g of strokes) paths.push(`<path d="${esc(g.path)}" fill="${paint}"/>`);
  }
  if (!paths.length) return "";
  return `<svg style="position:absolute;left:0;top:0;overflow:visible" width="${n2(Math.max(w, 1))}" height="${n2(Math.max(h, 1))}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${paths.join("")}</svg>`;
}

const fullCircle = (n: AnyNode) => {
  const a = n.arcData;
  return !a || ((a.innerRadius ?? 0) <= 0 && Math.abs((a.endingAngle ?? 2 * Math.PI) - (a.startingAngle ?? 0)) >= 2 * Math.PI - 1e-3);
};
const hasGeometry = (n: AnyNode) => (Array.isArray(n.fillGeometry) && n.fillGeometry.length > 0) || (Array.isArray(n.strokeGeometry) && n.strokeGeometry.length > 0);

/** drawn as an SVG of its paths: vectors, a boolean result, a line with stroke geometry, an arc / donut */
function drawnAsVector(n: AnyNode): boolean {
  if (!VECTORS.has(n.type) || !hasGeometry(n)) return false;
  if (n.type === "ELLIPSE") return !fullCircle(n);
  return true;
}

// ---------------------------------------------------------------- nodes

type Ctx = { fonts: FontUse; images: Set<string> };

/**
 * Children of a node, inside the box at (ox, oy). Figma lists them bottom to top; a mask clips every sibling above
 * it: they go into a box at the place of the mask, cut to its outline (the mask is not drawn).
 */
function childrenHtml(children: AnyNode[], ox: number, oy: number, L: Lin, ctx: Ctx, out: string[]) {
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    const b = boxOf(c);
    if (c.isMask && c.visible !== false && b) {
      const inner: string[] = [];
      childrenHtml(children.slice(i + 1), b.x, b.y, L, ctx, inner);
      const ml = mulLin(L, linOf(c));
      const paths = Array.isArray(c.fillGeometry) ? c.fillGeometry.filter((g: AnyNode) => g?.path) : [];
      let clip = `overflow:hidden;${radiusOf(c).css}`;
      if (paths.length && isId(ml) && c.type !== "RECTANGLE" && c.type !== "FRAME") {
        const rule = paths[0].windingRule === "EVENODD" ? "evenodd," : "";
        clip = `clip-path:path(${rule}'${paths.map((g: AnyNode) => g.path).join("")}');`;
      }
      out.push(`<div style="left:${px(b.x - ox)};top:${px(b.y - oy)};width:${px(b.width)};height:${px(b.height)};${clip}">${inner.join("")}</div>`);
      return;
    }
    nodeHtml(c, ox, oy, L, ctx, out);
  }
}

function nodeHtml(n: AnyNode, ox: number, oy: number, CL: Lin, ctx: Ctx, out: string[]) {
  if (n.visible === false) return;
  const b = boxOf(n);
  if (!b) {
    childrenHtml(childrenOf(n), ox, oy, CL, ctx, out);
    return;
  }
  const L = mulLin(CL, linOf(n));
  const rotated = !isId(L);
  const w = rotated ? Number(n.size?.x ?? b.width) : b.width;
  const h = rotated ? Number(n.size?.y ?? b.height) : b.height;
  let outer = `left:${px(b.x - ox)};top:${px(b.y - oy)};width:${px(b.width)};height:${px(b.height)};`;
  if (n.opacity != null && n.opacity < 1) outer += `opacity:${n2(n.opacity * 1000) / 1000};`;
  if (n.blendMode && BLEND[n.blendMode]) outer += `mix-blend-mode:${BLEND[n.blendMode]};`;
  // the element of the node's own drawing: the outer box, or turned in its own size around the center of the box
  const turned = rotated
    ? `left:${px((b.width - w) / 2)};top:${px((b.height - h) / 2)};width:${px(w)};height:${px(h)};transform:matrix(${L.map((v) => n2(v * 1e4) / 1e4).join(",")},0,0);`
    : "";

  if (n.type === "TEXT") {
    const css = textCss(n, ctx.fonts);
    const html = `<p>${textContent(n, ctx.fonts)}</p>`;
    out.push(rotated ? `<div style="${outer}"><div style="${turned}${css}">${html}</div></div>` : `<div style="${outer}${css}">${html}</div>`);
    return;
  }
  const fx = effectsOf(n);
  if (drawnAsVector(n)) {
    // a boolean operation has the geometry of its result: its children are not drawn
    const svg = vectorSvg(n, w, h);
    if (!svg) return;
    const filter = [...fx.dropFilter, ...fx.filter];
    const f = filter.length ? `filter:${filter.join(" ")};` : "";
    out.push(rotated ? `<div style="${outer}${f}"><div style="${turned}">${svg}</div></div>` : `<div style="${outer}${f}">${svg}</div>`);
    return;
  }
  if (n.type === "LINE") {
    // a line without geometry: its stroke, centered on it
    const color = paintColor(visiblePaints(n.strokes));
    const sw = Number(n.strokeWeight ?? 1);
    if (!color || !sw) return;
    const line = `<div style="left:0;top:${px(-sw / 2)};width:${px(w)};height:${px(sw)};background:${color};"></div>`;
    out.push(rotated ? `<div style="${outer}"><div style="${turned}">${line}</div></div>` : `<div style="${outer}">${line}</div>`);
    return;
  }

  const fills = visiblePaints(n.fills);
  const bg = background(fills, w, h, ctx.images);
  const radius = radiusOf(n);
  let visual = bg.css + radius.css + fx.backdrop;
  const filters = [...fx.filter];
  // a shadow follows the shape of the node when it has paint, else what is drawn in it
  if (fills.length || n.type === "RECTANGLE" || n.type === "ELLIPSE") {
    if (fx.boxShadow.length) visual += `box-shadow:${fx.boxShadow.join(",")};`;
  } else filters.unshift(...fx.dropFilter);
  if (filters.length) outer += `filter:${filters.join(" ")};`;
  const stroke = strokeOverlay(n, visiblePaints(n.strokes), radius);

  const kids: string[] = [];
  childrenHtml(childrenOf(n), b.x, b.y, NOT_CONTAINERS.has(n.type) ? CL : L, ctx, kids);
  const clip = n.clipsContent === true;
  if (!rotated) {
    const content = clip && kids.length
      ? `<div style="left:0;top:0;width:100%;height:100%;overflow:hidden;border-radius:inherit">${kids.join("")}</div>`
      : kids.join("");
    out.push(`<div style="${outer}${visual}">${bg.layers}${content}${stroke}</div>`);
  } else {
    const own = visual || bg.layers || stroke ? `<div style="${turned}${visual}">${bg.layers}${stroke}</div>` : "";
    const content = kids.length ? `<div style="left:0;top:0;width:100%;height:100%;${clip ? "overflow:hidden;" : ""}">${kids.join("")}</div>` : "";
    out.push(`<div style="${outer}">${own}${content}</div>`);
  }
}

/** The design of a frame as HTML (area.ts): its box down to its design height, what it shows. */
export function frameHtml(frame: AnyNode): FrameHtml {
  const view = designFrame(frame);
  const b = boxOf(view)!;
  const ctx: Ctx = { fonts: new Map(), images: new Set() };
  const out: string[] = [];
  // the frame is drawn upright, at the top left of the image
  nodeHtml({ ...view, relativeTransform: undefined, opacity: undefined, effects: undefined, blendMode: undefined }, b.x, b.y, ID, ctx, out);
  return { body: `<div id="f">${out.join("")}</div>`, width: b.width, height: b.height, fonts: ctx.fonts, images: ctx.images };
}

/** The whole HTML page of a frame, with the @font-face rules given. */
export function framePage(f: FrameHtml, fontCss = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}
html,body{margin:0;padding:0;background:#fff}
#f{position:relative;overflow:hidden;width:${f.width}px;height:${f.height}px;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
#f div{position:absolute;box-sizing:border-box}
#f p{margin:0;padding:0}
</style></head><body>${f.body}</body></html>`;
}
