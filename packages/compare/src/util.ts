/** Text normalisation, colors and boxes shared by the matcher and the checks. */
import type { Box } from "@figtest/contracts";

// ------------------------------------------------------------------ text
const ZERO_WIDTH = /[\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{AD}]/gu;
const SPACES = /[\u{A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/gu;

/** Whitespace normalised: zero-width characters out, every space kind = " ", runs collapsed, trimmed. */
export const ws = (s: string): string => s.replace(ZERO_WIDTH, "").replace(SPACES, " ").replace(/\s+/g, " ").trim();

/** Key of an exact match: whitespace normalised, case folded (text-transform changes the case). */
export const keyOf = (s: string): string => ws(s).toLowerCase();

/**
 * Key of a loose match: full-width / half-width folded (NFKC: "ＡＢＣ１" = "ABC1", "ｺｲﾝ" = "コイン"), case folded,
 * quotes, dashes and tildes unified, no whitespace at all (spaces vary a lot, above all in CJK texts).
 */
export const looseOf = (s: string): string =>
  ws(s).normalize("NFKC").toLowerCase()
    .replace(/[\u{2018}\u{2019}\u{201A}\u{201B}\u{60}\u{B4}\u{2032}]/gu, "'")
    .replace(/[\u{201C}\u{201D}\u{201E}\u{201F}\u{2033}\u{300C}\u{300D}\u{300E}\u{300F}]/gu, '"')
    .replace(/[\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}]/gu, "-")
    .replace(/[\u{301C}\u{3030}]/gu, "~")
    .replace(/\s+/g, "");

/** Length in characters (code points). */
export const chars = (s: string): number => Array.from(s).length;

export const CJK = /[\u{3000}-\u{30FF}\u{3400}-\u{9FFF}\u{AC00}-\u{D7AF}\u{FF00}-\u{FFEF}]/u;

/** Figma text case or CSS text-transform applied to a text. */
export function applyCase(s: string, c: string): string {
  if (c === "upper" || c === "uppercase") return s.toUpperCase();
  if (c === "lower" || c === "lowercase") return s.toLowerCase();
  if (c === "title" || c === "capitalize") return s.replace(/(^|[^\p{L}\p{N}'\u{2019}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return s;
}

/** Similarity 0..1 = 1 - Levenshtein distance / longest length; 0 as soon as it is surely below `min`. */
export function similarity(a: string, b: string, min = 0): number {
  if (a === b) return 1;
  const x = Array.from(a), y = Array.from(b);
  const n = x.length, m = y.length;
  const longest = Math.max(n, m);
  if (!longest) return 1;
  const maxDist = Math.floor((1 - min) * longest);
  if (Math.abs(n - m) > maxDist) return 0;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1));
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return 0;
    [prev, cur] = [cur, prev];
  }
  return 1 - (prev[m] ?? longest) / longest;
}

/** Same font family name, whatever the case, quotes, spaces and dashes ("Noto Sans JP" = "NotoSansJP"). */
export const sameFamily = (a: string, b: string): boolean => a.replace(/["'\s_-]/g, "").toLowerCase() === b.replace(/["'\s_-]/g, "").toLowerCase();

// ------------------------------------------------------------------ colors
export type Rgba = [number, number, number, number];

/** #RGB, #RRGGBB or #RRGGBBAA → [r, g, b, a 0..255]; null for anything else. */
export function parseHex(hex: string | null | undefined): Rgba | null {
  if (!hex) return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = Array.from(h).map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
export const toHex = (c: Rgba): string => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}${c[3] < 254.5 ? hex2(c[3]) : ""}`;

/** Largest difference over the channels (alpha included), 0..255. Unparsable on one side only: 255. */
export function colorDiff(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseHex(a), y = parseHex(b);
  if (!x || !y) return !x && !y ? 0 : 255;
  return Math.max(...x.map((v, i) => Math.abs(v - (y[i] ?? 0))));
}

/** Color `fg` (its alpha × opacity) painted over the opaque color `bg`: what is seen. */
export function composite(fg: string | null | undefined, bg: string, opacity = 1): string {
  const f = parseHex(fg), b = parseHex(bg) ?? [255, 255, 255, 255];
  if (!f) return toHex([b[0], b[1], b[2], 255]);
  const a = (f[3] / 255) * Math.max(0, Math.min(1, opacity));
  return toHex([f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 255]);
}

// ------------------------------------------------------------------ numbers & boxes
export const r1 = (n: number): number => Math.round(n * 10) / 10;
export const r2 = (n: number): number => Math.round(n * 100) / 100;

export function union(boxes: Box[]): Box {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return boxes.length ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Distance between two boxes (0 when they touch or overlap). */
export function gapDistance(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

export const shift = (b: Box, dx: number, dy: number): Box => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });

/** Overlap of the horizontal spans of two boxes (negative when apart). */
export const overlapX = (a: Box, b: Box): number => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
