/** Public types of @figtest/compare (contract with the worker: keep the names and fields). */
import type { Box, Tolerances } from "@figtest/contracts";

export type DomText = {
  /** direct text nodes of the element (form fields: value, or placeholder) */
  own: string;
  placeholder?: boolean;
  /** innerText when the element has element children (block of inline content) */
  full: string | null;
  /** line boxes (glyph boxes grown by the half-leading): comparable with Figma text boxes */
  box: Box;
  /** raw union of the text rects */
  glyph: Box;
  lines: number;
  /** first family of the CSS font-family list */
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  /** px; CSS "normal" is measured (pitch of the lines, or the height of a probe in the same font) */
  lineHeight: number | null;
  lineHeightNormal: boolean;
  letterSpacing: number;
  color: string;
  decoration: "none" | "underline" | "line-through";
  transform: string;
  align: string;
  /** loaded: @font-face loaded; system: installed (or generic); not-loaded: @font-face not loaded, or not installed */
  fontStatus: "loaded" | "not-loaded" | "system";
};

export type DomElement = {
  i: number;
  /** index of the nearest collected ancestor, -1 for none */
  p: number;
  tag: string;
  /** short selector for humans: tag#id.class[data-testid] */
  sel: string;
  /** exact place: body > div:nth-child(1) > ... */
  path: string;
  box: Box;
  bg: string | null;
  bgImage: boolean;
  /** background-image is a gradient */
  bgGradient?: boolean;
  img: boolean;
  border: { t: number; r: number; b: number; l: number; color: string | null };
  radius: number;
  padding: { t: number; r: number; b: number; l: number };
  gap: { row: number; col: number };
  display: string;
  flexDirection: string;
  opacity: number;
  /** has a box-shadow */
  shadow?: boolean;
  text?: DomText;
};

export type DomSnapshot = {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  page: { w: number; h: number };
  elements: DomElement[];
};

/**
 * An accepted difference: the failed checks it matches become "ignored" (with the reason). Every field given must
 * match; a rule with none of node / text / prop matches nothing.
 */
export type IgnoreRule = {
  /** Figma node id: the node itself or anything inside it */
  node?: string;
  /** exact Figma text, or /regex/ (texts and spacing only) */
  text?: string;
  /** check name ("fontSize", "missing", "background"...), or its start ("inset" = insetTop, insetLeft...) */
  prop?: string;
  reason: string;
};

export interface CompareOptions {
  tolerances?: Partial<Tolerances>;
  ignore?: IgnoreRule[];
  /** URL of the page, copied to the report */
  url?: string;
}
