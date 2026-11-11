/** Small helpers shared by the modules of the package (not exported by the package). */

/** A node of the REST-shaped tree, read loosely (FigmaNode fields are `unknown`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNode = Record<string, any>;

export type Rect = { x: number; y: number; width: number; height: number };

/** Rounded to 2 decimals (boxes, sizes: float noise of the transforms away). */
export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Color {r,g,b,a} 0..1 → #RRGGBB, or #RRGGBBAA when not opaque. */
export function hexColor(c: { r: number; g: number; b: number; a?: number }, opacity = 1): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();
  const a = (c.a ?? 1) * opacity;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 0.999 ? h(a) : ""}`;
}

/** Visible paints of a fills / strokes list. */
export const visiblePaints = (paints: unknown): AnyNode[] =>
  (Array.isArray(paints) ? paints : []).filter((p: AnyNode) => p && p.visible !== false && (p.opacity ?? 1) > 0);

/** First visible solid paint as #RRGGBB(AA), or null. */
export function solidHex(paints: unknown): string | null {
  const p = visiblePaints(paints).find((x) => x.type === "SOLID" && x.color);
  return p ? hexColor(p.color, p.opacity ?? 1) : null;
}

export const childrenOf = (n: AnyNode): AnyNode[] => (Array.isArray(n.children) ? n.children : []);

export const boxOf = (n: AnyNode): Rect | null => {
  const b = n.absoluteBoundingBox;
  return b && typeof b.x === "number" && typeof b.y === "number" ? b : null;
};

/** Font weight of a Figma font style name ("Bold", "SemiBold", "W6", "Extra Light Italic" ...). */
const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra\s*light|ultra\s*light/i, 200], [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800], [/black|heavy/i, 900], [/light/i, 300], [/medium/i, 500], [/bold/i, 700],
];
export function weightOfStyle(style = ""): number {
  const w = /^W(\d)$/i.exec(style.trim()); // Hiragino: W3 ... W9
  if (w) return Number(w[1]) * 100;
  return WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;
}

/** Waits `ms`, rejects when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError(signal!)); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
