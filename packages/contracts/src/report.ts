/**
 * The report of one screen: what @figtest/compare produces from the design spec and the DOM of the page, what the
 * report viewer of the web draws. Plain types (no zod): the api stores it as a gzip blob and serves it as is.
 *
 * Boxes are CSS pixels. Figma boxes are relative to the top-left of the frame, DOM boxes to the top-left of the page
 * (scroll 0): for a 1440 px frame tested on a 1440 px wide viewport they line up, so both can be drawn on the images.
 */

export type Box = { x: number; y: number; w: number; h: number };

export type CheckStatus = "pass" | "fail" | "ignored" | "info";

/** One compared property (fontSize, color, width, gap ...). */
export type Check = {
  prop: string;
  expected: string | number | null;
  actual: string | number | null;
  diff?: number | string;
  /** the tolerance used, for humans ("±1px") */
  tol?: string;
  status: CheckStatus;
  note?: string;
  /** why it is ignored */
  reason?: string;
};

/** A text of the design and the DOM text it was matched with. */
export type TextResult = {
  key: string;
  node: string;
  name: string;
  text: string;
  /** paragraph index when the text was matched paragraph by paragraph */
  part?: number;
  status: "pass" | "fail" | "missing" | "ignored";
  match?: "own" | "block" | "loose" | "fuzzy" | "part";
  figma: Box;
  dom?: { i: number; sel: string; path: string; text: string; box: Box };
  checks: Check[];
};

/** A frame / group / shape of the design (background, border, radius, padding, gap) and its DOM element. */
export type ContainerResult = {
  key: string;
  node: string;
  name: string;
  type: string;
  figma: Box;
  status: "pass" | "fail" | "ignored";
  confidence: "high" | "low";
  dom?: { i: number; sel: string; path: string; box: Box };
  checks: Check[];
};

/** Vertical space between two texts next to each other. */
export type SpacingResult = {
  key: string;
  from: { node: string; text: string };
  to: { node: string; text: string };
  check: Check;
};

export type CompareSummary = {
  /** share of the design texts found on the page, 0..1 */
  coverage: number;
  /** % of the checks on matched elements that pass (ignored and info left out), 0..100 */
  designScore: number;
  texts: number;
  matched: number;
  missing: number;
  checks: number;
  failed: number;
  ignored: number;
  typographyFails: number;
  containerFails: number;
  spacingFails: number;
  unmatchedContainers: number;
};

export type Tolerances = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  /** per channel, 0-255 */
  color: number;
  /** width/height: max(sizePx, sizePct * value) */
  sizePx: number;
  sizePct: number;
  position: number;
  spacing: number;
  maxSpacing: number;
  shortTextRadius: number;
};

export type CompareReport = {
  schema: 1;
  frame: { id: string; name: string; size: { w: number; h: number } };
  url: string;
  page: { w: number; h: number };
  tolerances: Tolerances;
  summary: CompareSummary;
  texts: TextResult[];
  containers: ContainerResult[];
  unmatchedContainers: { node: string; name: string; type: string; figma: Box; reason: string }[];
  spacing: SpacingResult[];
};
