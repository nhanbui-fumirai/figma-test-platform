/**
 * Compares the spec of a Figma frame (DesignSpec) with the DOM of the page (DomSnapshot).
 *
 * 1. Texts (coverage): every Figma text is paired with the DOM text showing it (match.ts). Then, on each match:
 *    text, case (Figma text case vs CSS text-transform), font family (+ whether the font loaded), size, weight,
 *    line height, letter spacing, color, decoration, line count, alignment (several lines). Position: info only.
 * 2. Containers: frames / instances / groups with auto layout or a visible paint are anchored on the DOM element that
 *    holds their texts (lowest common ancestor, or the ancestor closest in size). Checked: size, background, border,
 *    radius, shadow, insets (space between the edges and the texts = padding), auto-layout gap. Matches of low
 *    confidence (size far off) are shown with "info" checks only. The root frame is skipped (it is the page).
 * 3. Spacing: vertical space between a text and the next text below it (horizontally overlapping).
 *
 * Design score = checks passed / (checks - ignored - info) on the matched elements; coverage = texts found / texts.
 */
import type { Box, Check, CompareReport, CompareSummary, ContainerResult, SpacingResult, TextResult, Tolerances } from "@figtest/contracts";
import type { DesignNode, DesignSpec } from "@figtest/figma";
import { matchTexts, type Hit, type Unit } from "./match";
import type { CompareOptions, DomElement, DomSnapshot, IgnoreRule } from "./types";
import { applyCase, colorDiff, composite, keyOf, overlapX, r1, r2, sameFamily, union, ws } from "./util";

export const DEFAULT_TOLERANCES: Tolerances = {
  fontSize: 1, lineHeight: 2, letterSpacing: 0.5, color: 8, sizePx: 4, sizePct: 0.03, position: 4, spacing: 4, maxSpacing: 120, shortTextRadius: 80,
};

const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SECTION"]);
/** geometry score (relative size difference w + h) of a confident container match, and of any match */
const HIGH_CONFIDENCE = 0.25;
const MAX_CONTAINER_SCORE = 0.6;
const RADIUS_TOL = 1;
const BORDER_TOL = 0.5;

// ------------------------------------------------------------------ checks
function num(prop: string, expected: number | null, actual: number | null, tol: number, unit = "px", note?: string, round = r1): Check {
  const n = note ? { note } : {};
  if (expected === null || actual === null) return { prop, expected, actual, status: "info", tol: `±${tol}${unit}`, ...n };
  const diff = round(actual - expected);
  return { prop, expected: round(expected), actual: round(actual), diff, tol: `±${tol}${unit}`, status: Math.abs(actual - expected) <= tol + 1e-6 ? "pass" : "fail", ...n };
}

function same(prop: string, expected: string | number, actual: string | number, note?: string): Check {
  const ok = String(expected).toLowerCase() === String(actual).toLowerCase();
  return { prop, expected, actual, status: ok ? "pass" : "fail", ...(note ? { note } : {}) };
}

function size(prop: string, expected: number, actual: number, t: Tolerances): Check {
  const tol = Math.max(t.sizePx, expected * t.sizePct);
  return {
    prop, expected: r1(expected), actual: r1(actual), diff: r1(actual - expected), tol: `±max(${t.sizePx}px, ${r2(t.sizePct * 100)}%)`,
    status: Math.abs(actual - expected) <= tol + 1e-6 ? "pass" : "fail",
  };
}

/** Colors compared as seen: each painted over the same backdrop (alpha and opacity taken into account). */
function color(prop: string, expected: string, actual: string | null, tol: number, seen: { expected: string; actual: string } | null, note?: string): Check {
  const diff = seen ? colorDiff(seen.expected, seen.actual) : colorDiff(expected, actual);
  return { prop, expected, actual: actual ?? "none", diff, tol: `±${tol}/255`, status: diff <= tol ? "pass" : "fail", ...(note ? { note } : {}) };
}

const info = (prop: string, expected: string | number | null, actual: string | number | null, note?: string): Check =>
  ({ prop, expected, actual, status: "info", ...(note ? { note } : {}) });

// ------------------------------------------------------------------ ignore rules
type Scope = { nodes: Set<string>; texts: string[] };

function ruleMatches(rule: IgnoreRule, scope: Scope, prop: string): boolean {
  if (!rule.node && !rule.text && !rule.prop) return false;
  if (rule.prop && rule.prop !== prop && !prop.startsWith(rule.prop)) return false;
  if (rule.node && !scope.nodes.has(rule.node)) return false;
  if (rule.text) {
    const re = /^\/(.*)\/([a-z]*)$/s.exec(rule.text);
    let test: (s: string) => boolean;
    if (re) {
      let rx: RegExp | null = null;
      try { rx = new RegExp(re[1] ?? "", (re[2] ?? "").replace(/[gy]/g, "")); } catch { rx = null; } // g / y: test() would keep state
      test = (s) => !!rx && rx.test(s);
    } else {
      const want = ws(rule.text);
      test = (s) => ws(s) === want;
    }
    if (!scope.texts.some(test)) return false;
  }
  return true;
}

function applyIgnore(checks: Check[], rules: IgnoreRule[], scope: Scope): void {
  if (!rules.length) return;
  for (const c of checks) {
    if (c.status !== "fail") continue;
    const rule = rules.find((r) => ruleMatches(r, scope, c.prop));
    if (rule) { c.status = "ignored"; c.reason = rule.reason; }
  }
}

const statusOf = (checks: Check[]): "pass" | "fail" | "ignored" =>
  checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "ignored") ? "ignored" : "pass";

// ------------------------------------------------------------------ main
/** Compares the spec of a frame with the DOM of the page. */
export function compareDesign(spec: DesignSpec, dom: DomSnapshot, opts: CompareOptions = {}): CompareReport {
  const t: Tolerances = { ...DEFAULT_TOLERANCES };
  for (const [k, v] of Object.entries(opts.tolerances ?? {})) if (typeof v === "number" && Number.isFinite(v)) t[k as keyof Tolerances] = v;
  const rules = (opts.ignore ?? []).filter((r) => r && (r.node || r.text || r.prop));
  const els = dom.elements;
  const elAt = (i: number): DomElement | undefined => els[i];

  // ---- Figma tree
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const figmaChainMemo = new Map<string, Set<string>>();
  /** the node and its ancestors */
  const figmaChain = (id: string): Set<string> => {
    let s = figmaChainMemo.get(id);
    if (!s) {
      s = new Set<string>();
      for (let n = byId.get(id), guard = 0; n && guard < 10_000; n = n.parent ? byId.get(n.parent) : undefined, guard++) s.add(n.id);
      figmaChainMemo.set(id, s);
    }
    return s;
  };
  const textsInside = (n: DesignNode): DesignNode[] => {
    const out: DesignNode[] = [];
    const stack = [...n.children].reverse();
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = byId.get(id);
      if (!c) continue;
      if (c.text) out.push(c);
      for (let k = c.children.length - 1; k >= 0; k--) stack.push(c.children[k]!);
    }
    return out;
  };
  /** background seen behind / inside a Figma node: its solid fill over what is under it */
  const figmaBgMemo = new Map<string, string>();
  const figmaBg = (id: string | null): string => {
    if (!id) return "#FFFFFF";
    const known = figmaBgMemo.get(id);
    if (known) return known;
    const n = byId.get(id);
    figmaBgMemo.set(id, "#FFFFFF"); // cycle guard
    const under = n ? figmaBg(n.parent) : "#FFFFFF";
    const v = n?.visual;
    const out = v?.fill && !v.image && !v.gradient ? composite(v.fill, under, v.opacity ?? 1) : under;
    figmaBgMemo.set(id, out);
    return out;
  };

  // ---- DOM tree
  const domAncMemo = new Map<number, number[]>();
  /** ancestors of a DOM element, nearest first */
  const domAncestors = (i: number): number[] => {
    let a = domAncMemo.get(i);
    if (!a) {
      a = [];
      for (let p = elAt(i)?.p ?? -1, guard = 0; p >= 0 && guard < 10_000; p = elAt(p)?.p ?? -1, guard++) a.push(p);
      domAncMemo.set(i, a);
    }
    return a;
  };
  const related = (a: number, b: number) => a === b || domAncestors(a).includes(b) || domAncestors(b).includes(a);
  const domBgMemo = new Map<number, string>();
  /** background seen behind / inside a DOM element */
  const domBg = (i: number): string => {
    const known = domBgMemo.get(i);
    if (known) return known;
    let out = "#FFFFFF";
    // from the root down, iteratively (deep pages)
    const chain = [i, ...domAncestors(i)].reverse();
    for (const k of chain) {
      const memo = domBgMemo.get(k);
      if (memo) { out = memo; continue; }
      const e = elAt(k);
      if (e?.bg) out = composite(e.bg, out, e.opacity ?? 1);
      domBgMemo.set(k, out);
    }
    return out;
  };

  // ================================================================ 1. texts
  const tm = matchTexts(spec, dom, t);
  const texts: TextResult[] = [];
  const domOfNode = new Map<string, { el: DomElement; box: Box; hit: Hit }[]>();
  const nodeState = new Map<string, "matched" | "missing" | "ignored">();
  let tk = 0;

  const textChecks = (u: Unit, hit: Hit, byParagraph: boolean): Check[] => {
    const s = u.node.text!;
    const d = hit.c.dt;
    const content = hit.c.kind === "own" ? d.own : d.full ?? d.own; // block text: innerText, text-transform applied
    const shown = hit.c.kind === "own" ? applyCase(d.own, d.transform) : content;
    const checks: Check[] = [];

    // text, then its case
    let textOk: boolean;
    if (hit.level === "part") {
      textOk = true;
      checks.push({ prop: "text", expected: u.text, actual: ws(content), status: "pass", note: "one part of a longer text of the page" });
    } else {
      textOk = keyOf(content) === u.key;
      let note: string | undefined;
      if (!textOk && hit.level === "loose") {
        note = ws(content).normalize("NFKC").toLowerCase() === u.text.normalize("NFKC").toLowerCase()
          ? "same text in other full-width / half-width characters"
          : "same text with other quotes, dashes, full-width / half-width characters or spaces";
      } else if (!textOk && hit.level === "fuzzy") note = `similar text (${Math.round((hit.similarity ?? 0) * 100)}% alike)`;
      if (d.placeholder) note = note ? `${note}; placeholder` : "placeholder of a form field";
      checks.push({ prop: "text", expected: u.text, actual: ws(content), status: textOk ? "pass" : "fail", ...(note ? { note } : {}) });
    }
    const caseDiffers = hit.level === "part" ? false : ws(content) !== u.text;
    if (textOk && (s.textCase !== "none" || (d.transform && d.transform !== "none") || caseDiffers)) {
      const expected = applyCase(u.text, s.textCase);
      const actual = ws(shown);
      const ok = hit.level === "part" ? actual.includes(expected) : actual === expected;
      checks.push({ prop: "textCase", expected, actual, status: ok ? "pass" : "fail", note: `Figma text case: ${s.textCase}, CSS text-transform: ${d.transform || "none"}` });
    }

    // font
    const fontNote = d.fontStatus === "system" ? "font of the system" : d.fontStatus === "not-loaded" ? "font not loaded" : "web font loaded";
    checks.push({ prop: "fontFamily", expected: s.fontFamily, actual: d.fontFamily, status: sameFamily(s.fontFamily, d.fontFamily) ? "pass" : "fail", note: fontNote });
    if (d.fontStatus === "not-loaded") {
      checks.push({ prop: "fontLoaded", expected: "loaded", actual: "not loaded", status: "fail",
        note: `${d.fontFamily} ${d.fontWeight} is neither loaded with @font-face nor installed: a fallback font is drawn` });
    }
    checks.push(num("fontSize", s.fontSize, d.fontSize, t.fontSize));
    checks.push(same("fontWeight", s.fontWeight, d.fontWeight));

    // line height: Figma "auto" and CSS "normal" are both the font's own line height
    const lhNote = [s.lineHeightAuto ? "auto in Figma" : "", d.lineHeightNormal ? "normal in CSS (measured)" : ""].filter(Boolean).join(", ") || undefined;
    const lh = num("lineHeight", s.lineHeight, d.lineHeight, t.lineHeight, "px", lhNote);
    if (lh.status === "fail" && s.lineHeightAuto && d.lineHeightNormal) {
      lh.status = "info";
      lh.note = "auto in Figma, normal in CSS: both follow the font metrics";
    }
    checks.push(lh);
    checks.push(num("letterSpacing", s.letterSpacing, d.letterSpacing, t.letterSpacing, "px", undefined, r2));

    // color, seen over the Figma background of the text
    if (s.color) {
      const backdrop = figmaBg(u.node.parent);
      checks.push(color("color", s.color, d.color, t.color, { expected: composite(s.color, backdrop), actual: composite(d.color, backdrop) }));
    } else checks.push(info("color", null, d.color, "no solid fill in Figma (gradient or image)"));
    checks.push(same("decoration", s.decoration, d.decoration));

    if (!byParagraph && hit.level !== "part" && (s.autoResize === "WIDTH_AND_HEIGHT" || s.autoResize === "HEIGHT")) {
      checks.push(same("lines", s.lines, d.lines, s.mixed ? "mixed styles in Figma" : undefined));
    }
    if (s.lines > 1 && hit.level !== "part") checks.push(same("align", s.align, d.align));
    checks.push(info("position", `${r1(u.node.box.x)}, ${r1(u.node.box.y)}`, `${r1(d.box.x)}, ${r1(d.box.y)}`, "absolute position: info only"));
    if (s.mixed) checks.push(info("mixedStyle", "base style compared", null, "part of the Figma text has another style"));
    return checks;
  };

  const textResult = (u: Unit, hit: Hit | undefined, byParagraph: boolean): TextResult => {
    const key = `t${++tk}`;
    const scope: Scope = { nodes: figmaChain(u.node.id), texts: [u.text, ws(u.node.text!.characters)] };
    const part = u.part === undefined ? {} : { part: u.part };
    if (!hit) {
      const checks: Check[] = [{ prop: "missing", expected: u.text, actual: null, status: "fail", note: "text not found in the page" }];
      applyIgnore(checks, rules, scope);
      return { key, node: u.node.id, name: u.node.name, text: u.text, ...part, status: checks[0]!.status === "ignored" ? "ignored" : "missing", figma: u.node.box, checks };
    }
    const checks = textChecks(u, hit, byParagraph);
    applyIgnore(checks, rules, scope);
    const d = hit.c.dt;
    const shown = hit.c.kind === "own" ? applyCase(d.own, d.transform) : d.full ?? d.own;
    const match: TextResult["match"] = hit.level === "exact" ? hit.c.kind : hit.level;
    domOfNode.set(u.node.id, [...(domOfNode.get(u.node.id) ?? []), { el: hit.c.el, box: d.box, hit }]);
    return {
      key, node: u.node.id, name: u.node.name, text: u.text, ...part, status: statusOf(checks), match, figma: u.node.box,
      dom: { i: hit.c.el.i, sel: hit.c.el.sel, path: hit.c.el.path, text: ws(shown), box: d.box }, checks,
    };
  };

  for (const u of tm.whole) {
    const hit = tm.hits.get(u);
    const paras = tm.paragraphs.get(u.node.id);
    const byParagraph = !hit && !!paras && paras.some((p) => tm.hits.has(p));
    const results = byParagraph ? paras!.map((p) => textResult(p, tm.hits.get(p), true)) : [textResult(u, hit, false)];
    texts.push(...results);
    nodeState.set(u.node.id, results.some((r) => r.status === "missing") ? "missing" : results.every((r) => !r.dom) ? "ignored" : "matched");
  }

  // ================================================================ 2. containers
  const containers: ContainerResult[] = [];
  const unmatchedContainers: CompareReport["unmatchedContainers"] = [];
  type Plan = { n: DesignNode; inner: DesignNode[]; el: DomElement; geo: number; visible: boolean };
  const plans: Plan[] = [];

  for (const n of spec.nodes) {
    if (!n.parent || !CONTAINER_TYPES.has(n.type)) continue; // the root frame is the page
    const v = n.visual;
    const backdrop = figmaBg(n.parent);
    const solid = v?.fill && !v.image && !v.gradient ? v.fill : null;
    const visible = !!v && (
      (!!solid && colorDiff(composite(solid, backdrop, v.opacity ?? 1), backdrop) > t.color) || !!v.stroke || v.image || v.gradient || v.shadow);
    const component = n.type === "INSTANCE" || n.type === "COMPONENT";
    if (!n.layout && !visible && !component) continue;
    // a plain wrapper of one child with the same box adds nothing
    if (!visible && n.children.length === 1) {
      const only = byId.get(n.children[0]!);
      if (only && Math.abs(only.box.x - n.box.x) <= 1 && Math.abs(only.box.y - n.box.y) <= 1 && Math.abs(only.box.w - n.box.w) <= 1 && Math.abs(only.box.h - n.box.h) <= 1) continue;
    }
    const all = textsInside(n);
    if (!all.length) continue; // icons, images: nothing to anchor on
    const listed = visible || component;
    const inner = all.filter((x) => domOfNode.has(x.id));
    if (!inner.length) {
      if (listed) unmatchedContainers.push({ node: n.id, name: n.name, type: n.type, figma: n.box, reason: `none of its ${all.length} text(s) is on the page` });
      continue;
    }
    // lowest common ancestor of the DOM texts, then the ancestor closest in size
    const domEls = inner.flatMap((x) => (domOfNode.get(x.id) ?? []).map((d) => d.el.i));
    const first = domEls[0]!;
    const lca = [first, ...domAncestors(first)].find((i) => domEls.every((j) => j === i || domAncestors(j).includes(i)));
    if (lca === undefined) {
      if (listed) unmatchedContainers.push({ node: n.id, name: n.name, type: n.type, figma: n.box, reason: "its texts have no common element in the page" });
      continue;
    }
    const geometry = (e: DomElement) => Math.abs(e.box.w - n.box.w) / Math.max(1, n.box.w) + Math.abs(e.box.h - n.box.h) / Math.max(1, n.box.h);
    const options = [lca, ...domAncestors(lca).slice(0, 6)].map(elAt).filter((e): e is DomElement => !!e);
    const rank = (e: DomElement, k: number) => geometry(e) + (solid && colorDiff(composite(solid, backdrop, v?.opacity ?? 1), domBg(e.i)) > t.color ? 0.25 : 0) + k * 0.001;
    let best = options[0]!, bestRank = Infinity;
    options.forEach((e, k) => { const r = rank(e, k); if (r < bestRank) { bestRank = r; best = e; } });
    const geo = geometry(best);
    if (geo > MAX_CONTAINER_SCORE) {
      if (listed) {
        unmatchedContainers.push({ node: n.id, name: n.name, type: n.type, figma: n.box,
          reason: `closest element of the page ${best.sel} is ${Math.round(best.box.w)}×${Math.round(best.box.h)}, Figma ${Math.round(n.box.w)}×${Math.round(n.box.h)}` });
      }
      continue;
    }
    plans.push({ n, inner, el: best, geo, visible });
  }

  // one Figma container per DOM element: the painted one, then the closest in size, then the deepest
  const owner = new Map<number, Plan>();
  for (const p of plans) {
    const o = owner.get(p.el.i);
    const better = !o || (p.visible !== o.visible ? p.visible : p.geo !== o.geo ? p.geo < o.geo : p.n.depth > o.n.depth);
    if (better) owner.set(p.el.i, p);
  }
  let ck = 0;
  for (const p of plans) {
    if (owner.get(p.el.i) !== p) continue;
    const { n, inner, el: e, geo } = p;
    const v = n.visual;
    const solid = v?.fill && !v.image && !v.gradient ? v.fill : null;
    const checks: Check[] = [];
    checks.push(size("width", n.box.w, e.box.w, t));
    checks.push(size("height", n.box.h, e.box.h, t));

    // background, as seen
    const under = e.p >= 0 ? domBg(e.p) : "#FFFFFF";
    const domPaints = !!e.bg && colorDiff(composite(e.bg, under, e.opacity ?? 1), under) > t.color;
    if (solid || domPaints) {
      const expected = figmaBg(n.id), actual = domBg(e.i);
      const notes = [solid ? "" : "no fill in Figma: the color behind it", e.bg ? "" : "no background of its own: the color behind it"].filter(Boolean);
      checks.push(color("background", expected, actual, t.color, null, notes.join("; ") || undefined));
    }
    if (v?.image) {
      const hasImg = e.bgImage || els.some((x) => x.img && domAncestors(x.i).includes(e.i) && x.box.w * x.box.h >= 0.8 * e.box.w * e.box.h);
      checks.push(info("image", "image fill", hasImg ? "image" : "none"));
    }
    if (v?.gradient) checks.push(info("gradient", "gradient fill", e.bgGradient ? "gradient" : "none"));

    // border
    const domBorder = Math.max(e.border.t, e.border.r, e.border.b, e.border.l);
    const domBorderColor = domBorder > 0 ? e.border.color : null;
    if (v?.stroke) {
      checks.push(num("borderWidth", v.stroke.weight, domBorderColor ? domBorder : 0, BORDER_TOL));
      if (domBorderColor) {
        const behind = domBg(e.i);
        checks.push(color("borderColor", v.stroke.color, domBorderColor, t.color, { expected: composite(v.stroke.color, behind), actual: composite(domBorderColor, behind) }));
      }
    } else if (domBorder >= 1 && domBorderColor) {
      checks.push({ prop: "borderWidth", expected: 0, actual: r1(domBorder), status: "fail", note: "border in the page, none in Figma" });
    }

    // radius: only where something is painted; clamped like the renderers do
    const painted = !!(solid || v?.stroke || v?.image || v?.gradient) || domPaints || domBorder > 0 || e.bgImage || !!e.bgGradient;
    const fr = Math.min(v?.radius ?? 0, Math.min(n.box.w, n.box.h) / 2);
    const dr = Math.min(e.radius, Math.min(e.box.w, e.box.h) / 2);
    if (painted && (fr > 0 || dr > 0)) checks.push(num("radius", fr, dr, RADIUS_TOL));
    if (v?.shadow || e.shadow) checks.push(same("shadow", v?.shadow ? "yes" : "no", e.shadow ? "yes" : "no"));

    // insets: space between the edges and the texts, same texts on both sides. A fixed-width Figma text box says
    // nothing about where its glyphs end: left / right only use the texts aligned to that edge.
    const autoW = (x: DesignNode) => x.text!.autoResize === "WIDTH_AND_HEIGHT";
    const sides = {
      t: inner, b: inner,
      l: inner.filter((x) => autoW(x) || x.text!.align === "left" || x.text!.align === "justify"),
      r: inner.filter((x) => autoW(x) || x.text!.align === "right" || x.text!.align === "justify"),
    };
    const domBoxes = (xs: DesignNode[]) => xs.flatMap((x) => (domOfNode.get(x.id) ?? []).map((d) => d.box));
    const label = { t: "insetTop", r: "insetRight", b: "insetBottom", l: "insetLeft" } as const;
    for (const side of ["t", "r", "b", "l"] as const) {
      const xs = sides[side];
      if (!xs.length) continue;
      const inset = (b: Box, u: Box) => ({ t: u.y - b.y, l: u.x - b.x, r: b.x + b.w - (u.x + u.w), b: b.y + b.h - (u.y + u.h) })[side];
      const note = n.layout ? `space between the edge and the texts (auto layout padding ${r1(n.layout.padding[side])}px)` : "space between the edge and the texts";
      checks.push(num(label[side], inset(n.box, union(xs.map((x) => x.box))), inset(e.box, union(domBoxes(xs))), t.position, "px", note));
    }

    // auto-layout gap between the children, measured between their texts
    if (n.layout && !n.layout.wrap && n.children.length > 1) {
      const horiz = n.layout.mode === "HORIZONTAL";
      const kids = n.children.map((id) => byId.get(id)).filter((c): c is DesignNode => !!c)
        .map((c) => ({ c, xs: (c.text ? [c] : textsInside(c)).filter((x) => domOfNode.has(x.id)) }))
        .filter((k) => k.xs.length);
      for (let k = 1; k < kids.length; k++) {
        const a = kids[k - 1]!, b = kids[k]!;
        // horizontal: the right edge of a / the left edge of b must be where the glyphs are
        if (horiz && !(a.xs.every((x) => autoW(x) || x.text!.align === "right") && b.xs.every((x) => autoW(x) || x.text!.align === "left"))) continue;
        const fa = union(a.xs.map((x) => x.box)), fb = union(b.xs.map((x) => x.box));
        const da = union(domBoxes(a.xs)), db = union(domBoxes(b.xs));
        const fg = horiz ? fb.x - (fa.x + fa.w) : fb.y - (fa.y + fa.h);
        const dg = horiz ? db.x - (da.x + da.w) : db.y - (da.y + da.h);
        checks.push(num("gap", fg, dg, t.position, "px", `${a.c.name} → ${b.c.name} (item spacing ${r1(n.layout.gap)}px)`));
      }
    }

    const confidence = geo <= HIGH_CONFIDENCE ? "high" : "low";
    if (confidence === "low") {
      for (const c of checks) {
        if (c.status === "pass" || c.status === "fail") {
          c.note = `${c.note ? `${c.note}; ` : ""}${c.status === "fail" ? "differs" : "same"}, not scored: the element of the page found for it is far from its size`;
          c.status = "info";
        }
      }
    }
    applyIgnore(checks, rules, { nodes: figmaChain(n.id), texts: [] });
    containers.push({
      key: `c${++ck}`, node: n.id, name: n.name, type: n.type, figma: n.box, status: statusOf(checks), confidence,
      dom: { i: e.i, sel: e.sel, path: e.path, box: e.box }, checks,
    });
  }

  // ================================================================ 3. vertical spacing between adjacent texts
  const spacing: SpacingResult[] = [];
  let sk = 0;
  for (const a of tm.whole) {
    const ha = tm.hits.get(a);
    if (!ha || ha.level === "part") continue;
    const fa = a.node.box;
    let b: Unit | undefined;
    for (const x of tm.whole) {
      const fx = x.node.box;
      if (x === a || fx.y < fa.y + fa.h - 2 || overlapX(fa, fx) <= 0 || fx.y - (fa.y + fa.h) > t.maxSpacing) continue;
      if (!b || fx.y < b.node.box.y || (fx.y === b.node.box.y && overlapX(fa, fx) > overlapX(fa, b.node.box))) b = x;
    }
    if (!b) continue;
    const hb = tm.hits.get(b); // the text right below must be matched as a whole, else nothing to compare
    if (!hb || hb.level === "part" || related(ha.c.el.i, hb.c.el.i)) continue;
    const da = ha.c.dt.box, db = hb.c.dt.box;
    const check = num("verticalSpace", b.node.box.y - (fa.y + fa.h), db.y - (da.y + da.h), t.spacing);
    if (db.y + db.h / 2 < da.y + da.h / 2) { check.status = "fail"; check.note = "order differs: in the page the second text is above the first"; }
    applyIgnore([check], rules, { nodes: new Set([...figmaChain(a.node.id), ...figmaChain(b.node.id)]), texts: [a.text, b.text] });
    spacing.push({ key: `s${++sk}`, from: { node: a.node.id, text: a.text }, to: { node: b.node.id, text: b.text }, check });
  }

  // ================================================================ summary
  const scoredTexts = texts.filter((x) => x.dom);
  const all = [...scoredTexts.flatMap((x) => x.checks), ...containers.flatMap((c) => c.checks), ...spacing.map((s) => s.check)];
  const count = (st: Check["status"], list: Check[] = all) => list.filter((c) => c.status === st).length;
  const passed = count("pass"), failed = count("fail"), ignored = count("ignored"), infos = count("info");
  const scored = all.length - ignored - infos;
  const states = [...nodeState.values()];
  const ignoredTexts = states.filter((s) => s === "ignored").length;
  const textCount = states.length - ignoredTexts;
  const matched = states.filter((s) => s === "matched").length;
  const summary: CompareSummary = {
    coverage: textCount ? Math.round((matched / textCount) * 10_000) / 10_000 : 1,
    designScore: scored ? Math.round((passed / scored) * 1000) / 10 : 100,
    texts: textCount,
    matched,
    missing: states.filter((s) => s === "missing").length,
    checks: all.length,
    failed,
    ignored,
    typographyFails: count("fail", scoredTexts.flatMap((x) => x.checks)),
    containerFails: count("fail", containers.flatMap((c) => c.checks)),
    spacingFails: count("fail", spacing.map((s) => s.check)),
    unmatchedContainers: unmatchedContainers.length,
  };

  return {
    schema: 1,
    frame: { id: spec.frameId, name: spec.frameName, size: spec.size },
    url: opts.url ?? dom.url,
    page: dom.page,
    tolerances: t,
    summary,
    texts,
    containers,
    unmatchedContainers,
    spacing,
  };
}

/** passed: every text found and no failed check; else failed. */
export function reportStatus(report: CompareReport): "passed" | "failed" {
  return report.summary.missing === 0 && report.summary.failed === 0 ? "passed" : "failed";
}
