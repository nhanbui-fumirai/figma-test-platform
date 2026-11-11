/**
 * Pairs every Figma text with the DOM text that shows it.
 *
 * Candidates: the own text of each DOM element, and the inner text of each block of inline content ("block").
 * Levels, strictest first, each one a global assignment (pairs sorted by cost, a DOM element used once):
 *   exact  whitespace and case normalised
 *   loose  + full-width / half-width, quotes, dashes, no spaces
 *   fuzzy  ≥ 4 characters: one text contains the other (≥ 60 % of it), or ≥ 80 % alike (edit distance)
 *   part   ≤ 12 characters: one word group of a longer DOM text near it ("X" and "1" vs "X 1")
 * A Figma text of several paragraphs the DOM does not hold in one element is matched paragraph by paragraph.
 * Long texts are matched first; they become anchors: the offset between Figma and DOM of the nearest one predicts
 * where a short text (≤ 3 characters, "1", "X", "Rs") is, and a short text only matches within shortTextRadius of its
 * Figma position or of that prediction. Among equal texts ("Home" in the header and the footer) the cost decides:
 * style difference + distance.
 */
import type { Box, Tolerances } from "@figtest/contracts";
import type { DesignNode, DesignSpec } from "@figtest/figma";
import type { DomElement, DomSnapshot, DomText } from "./types";
import { CJK, chars, colorDiff, gapDistance, keyOf, looseOf, shift, similarity, ws } from "./util";

export type Level = "exact" | "loose" | "fuzzy" | "part";

export type Unit = {
  node: DesignNode;
  /** the Figma text (whitespace normalised), or one paragraph of it */
  text: string;
  /** paragraph index, for paragraph units */
  part?: number;
  key: string;
  loose: string;
  short: boolean;
};

export type Candidate = { el: DomElement; dt: DomText; kind: "own" | "block"; value: string; key: string; loose: string; len: number };

export type Hit = { c: Candidate; level: Level; similarity?: number };

export type TextMatch = {
  /** one whole unit per Figma text node (in spec order) */
  whole: Unit[];
  /** paragraph units of the multi-paragraph texts, by node id */
  paragraphs: Map<string, Unit[]>;
  hits: Map<Unit, Hit>;
};

const SHORT = 3;
const PART_MAX = 12;

export function matchTexts(spec: DesignSpec, dom: DomSnapshot, tol: Tolerances): TextMatch {
  const els = dom.elements;

  // ---- candidates
  const candidates: Candidate[] = [];
  const byKey = new Map<string, Candidate[]>();
  const byLoose = new Map<string, Candidate[]>();
  const push = <K, V>(map: Map<K, V[]>, k: K, v: V) => { const list = map.get(k); if (list) list.push(v); else map.set(k, [v]); };
  const add = (el: DomElement, dt: DomText, kind: Candidate["kind"], value: string) => {
    const loose = looseOf(value);
    if (!loose) return;
    const c: Candidate = { el, dt, kind, value, key: keyOf(value), loose, len: chars(loose) };
    candidates.push(c);
    push(byKey, c.key, c);
    push(byLoose, c.loose, c);
  };
  for (const el of els) {
    if (!el.text) continue;
    if (el.text.own) add(el, el.text, "own", el.text.own);
    if (el.text.full) add(el, el.text, "block", el.text.full);
  }

  // ---- DOM ancestry
  const ancestorMemo = new Map<number, Set<number>>();
  const ancestors = (i: number): Set<number> => {
    let s = ancestorMemo.get(i);
    if (!s) {
      s = new Set<number>();
      for (let p = els[i]?.p ?? -1, guard = 0; p >= 0 && guard < 10_000; p = els[p]?.p ?? -1, guard++) s.add(p);
      ancestorMemo.set(i, s);
    }
    return s;
  };
  const related = (a: number, b: number) => a === b || ancestors(a).has(b) || ancestors(b).has(a);

  // ---- units
  const unit = (node: DesignNode, text: string, part?: number): Unit => {
    const loose = looseOf(text);
    return { node, text, ...(part === undefined ? {} : { part }), key: keyOf(text), loose, short: chars(loose) <= SHORT };
  };
  const whole: Unit[] = [];
  const paragraphs = new Map<string, Unit[]>();
  for (const node of spec.nodes) {
    if (!node.text) continue;
    const text = ws(node.text.characters);
    if (!looseOf(text)) continue;
    whole.push(unit(node, text));
    const paras = (node.text.paragraphs?.length ? node.text.paragraphs : node.text.characters.split(/\r?\n|\u{2028}|\u{2029}/u))
      .map((p, k) => ({ p: ws(p), k })).filter((x) => looseOf(x.p));
    if (paras.length > 1) paragraphs.set(node.id, paras.map((x) => unit(node, x.p, x.k)));
  }

  // ---- bookkeeping
  const hits = new Map<Unit, Hit>();
  const wholeHit = new Set<string>();
  const anyHit = new Set<string>();
  const usedEls = new Map<number, "whole" | "part">();
  const usedKeys = new Map<string, number[]>();
  const isUsed = (c: Candidate, level: Level) => {
    if (level === "part") return usedEls.get(c.el.i) === "whole";
    if (usedEls.has(c.el.i)) return true;
    // the same text already taken by an ancestor / a descendant (<a><span>Home</span></a>: one "Home")
    return (usedKeys.get(c.key) ?? []).some((j) => related(j, c.el.i));
  };

  // ---- positions: the Figma box, or the box predicted by the nearest anchor
  let anchors: { figma: Box; dom: Box }[] = [];
  const predicted = (u: Unit): Box | null => {
    let best: { figma: Box; dom: Box } | null = null, bestD = Infinity;
    for (const a of anchors) {
      const d = gapDistance(a.figma, u.node.box) + 0.001 * (Math.abs(a.figma.x - u.node.box.x) + Math.abs(a.figma.y - u.node.box.y));
      if (d < bestD) { bestD = d; best = a; }
    }
    return best ? shift(u.node.box, best.dom.x - best.figma.x, best.dom.y - best.figma.y) : null;
  };
  const predictedMemo = new Map<Unit, Box | null>();
  const predOf = (u: Unit): Box | null => {
    if (!predictedMemo.has(u)) predictedMemo.set(u, predicted(u));
    return predictedMemo.get(u) ?? null;
  };
  /** distance between the DOM text and the Figma box (or the predicted box), 0 when they overlap */
  const near = (u: Unit, c: Candidate) => {
    const p = predOf(u);
    return Math.min(gapDistance(u.node.box, c.dt.box), p ? gapDistance(p, c.dt.box) : Infinity);
  };
  /** distance between the top-left corners */
  const corner = (u: Unit, c: Candidate) => {
    const p = predOf(u);
    const d = (b: Box) => Math.abs(b.x - c.dt.box.x) + Math.abs(b.y - c.dt.box.y);
    return Math.min(d(u.node.box), p ? d(p) : Infinity);
  };

  const cost = (u: Unit, c: Candidate, sim: number) => {
    const s = u.node.text!, d = c.dt;
    const style = Math.abs(s.fontSize - d.fontSize) * 5 + Math.abs(s.fontWeight - d.fontWeight) / 20 + (s.color ? colorDiff(s.color, d.color) / 10 : 0);
    const pos = Math.min(500, corner(u, c) / 10 + near(u, c) / 10);
    return style + pos + (c.kind === "block" ? 2 : 0) + (1 - sim) * 50;
  };

  type Lookup = (u: Unit) => { c: Candidate; sim: number }[];
  const assign = (units: Unit[], lookup: Lookup, level: Level) => {
    const pairs: { u: Unit; c: Candidate; sim: number; cost: number }[] = [];
    for (const u of units) {
      for (const { c, sim } of lookup(u)) {
        // very short texts are everywhere: only near their place
        if ((u.short || level === "part") && near(u, c) > tol.shortTextRadius) continue;
        pairs.push({ u, c, sim, cost: cost(u, c, sim) });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    for (const p of pairs) {
      const id = p.u.node.id;
      if (hits.has(p.u) || isUsed(p.c, level)) continue;
      if (p.u.part === undefined ? anyHit.has(id) : wholeHit.has(id)) continue;
      hits.set(p.u, { c: p.c, level, ...(level === "fuzzy" ? { similarity: p.sim } : {}) });
      anyHit.add(id);
      if (p.u.part === undefined) wholeHit.add(id);
      if (usedEls.get(p.c.el.i) !== "whole") usedEls.set(p.c.el.i, level === "part" ? "part" : "whole");
      push(usedKeys, p.c.key, p.c.el.i);
    }
  };

  const exact: Lookup = (u) => (byKey.get(u.key) ?? []).map((c) => ({ c, sim: 1 }));
  const loose: Lookup = (u) => (byLoose.get(u.loose) ?? []).map((c) => ({ c, sim: 1 }));
  // character counts (64 buckets): their difference is a lower bound of the edit distance (buckets only weaken it),
  // cheap enough to skip most candidates before the edit distance
  const BUCKETS = 64;
  const bags = new Map<string, Int32Array>();
  const bagOf = (s: string) => {
    let b = bags.get(s);
    if (!b) {
      b = new Int32Array(BUCKETS);
      for (const ch of s) b[ch.codePointAt(0)! & (BUCKETS - 1)]! += 1;
      bags.set(s, b);
    }
    return b;
  };
  const bagDistance = (a: string, b: string) => {
    const x = bagOf(a), y = bagOf(b);
    let missing = 0, extra = 0;
    for (let k = 0; k < BUCKETS; k++) {
      const d = x[k]! - y[k]!;
      if (d > 0) missing += d; else extra -= d;
    }
    return Math.max(missing, extra);
  };
  const FUZZY_MIN = 0.8;
  const EDIT_MAX_LEN = 400;
  const fuzzy: Lookup = (u) => {
    const n = chars(u.loose);
    if (n < 4) return [];
    const out: { c: Candidate; sim: number }[] = [];
    for (const c of candidates) {
      if (c.len < 2) continue;
      let sim = 0;
      if (c.loose.includes(u.loose) && n / c.len >= 0.6) sim = n / c.len;
      else if (u.loose.includes(c.loose) && c.len / n >= 0.6) sim = c.len / n;
      const longest = Math.max(c.len, n);
      const maxDist = (1 - FUZZY_MIN) * longest;
      if (sim < FUZZY_MIN && longest <= EDIT_MAX_LEN && Math.abs(c.len - n) <= maxDist && bagDistance(u.loose, c.loose) <= maxDist) {
        const lev = similarity(u.loose, c.loose, FUZZY_MIN);
        if (lev >= FUZZY_MIN) sim = Math.max(sim, lev);
      }
      if (sim > 0) out.push({ c, sim });
    }
    return out;
  };
  const partOf: Lookup = (u) => {
    if (chars(u.loose) > PART_MAX) return [];
    const cjk = CJK.test(u.key);
    return candidates
      .filter((c) => c.kind === "own" && c.len > chars(u.loose) && (` ${c.key} `.includes(` ${u.key} `) || (cjk && c.key.includes(u.key))))
      .map((c) => ({ c, sim: 1 }));
  };

  const paraUnits = [...paragraphs.values()].flat();
  for (const short of [false, true]) {
    for (const [level, lookup] of [["exact", exact], ["loose", loose], ["fuzzy", fuzzy]] as const) {
      assign(whole.filter((u) => u.short === short && !anyHit.has(u.node.id)), lookup, level);
      assign(paraUnits.filter((u) => u.short === short && !wholeHit.has(u.node.id) && !hits.has(u)), lookup, level);
    }
    if (!short) {
      // anchors: long texts matched exactly or loosely
      anchors = whole.filter((u) => { const h = hits.get(u); return !!h && (h.level === "exact" || h.level === "loose"); })
        .map((u) => ({ figma: u.node.box, dom: hits.get(u)!.c.dt.box }));
      predictedMemo.clear();
    }
  }
  assign(whole.filter((u) => !anyHit.has(u.node.id)), partOf, "part");

  return { whole, paragraphs, hits };
}
