/**
 * The spec of a frame: what the compare engine checks. Nodes in drawing order, nodes[0] = the frame. Boxes relative to
 * the top-left of the frame, CSS px. Only what the design image shows: clipped / hidden nodes are left out.
 */
import type { Box } from "@figtest/contracts";

export type TextCase = "none" | "upper" | "lower" | "title" | "small-caps";
export type Decoration = "none" | "underline" | "line-through";

export type DesignText = {
  characters: string;
  /** characters split on line breaks (the DOM often has one <p> per paragraph) */
  paragraphs: string[];
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  /** px; also filled when Figma says "auto" (the font's own line height) */
  lineHeight: number | null;
  lineHeightAuto: boolean;
  /** px */
  letterSpacing: number;
  /** #RRGGBB or #RRGGBBAA, first visible solid fill */
  color: string | null;
  decoration: Decoration;
  textCase: TextCase;
  align: "left" | "center" | "right" | "justify";
  autoResize: "WIDTH_AND_HEIGHT" | "HEIGHT" | "NONE" | "TRUNCATE";
  lines: number;
  /** part of the text has another style (only the base style is compared) */
  mixed: boolean;
};

export type DesignLayout = {
  mode: "HORIZONTAL" | "VERTICAL";
  gap: number;
  padding: { t: number; r: number; b: number; l: number };
  primaryAlign?: string;
  counterAlign?: string;
  wrap?: boolean;
};

export type DesignVisual = {
  fill: string | null;
  gradient: boolean;
  image: boolean;
  stroke: { color: string; weight: number } | null;
  radius: number | null;
  opacity: number;
  shadow: boolean;
  /** GROUP: visual taken from its background rectangle child with this id */
  fromChild?: string;
};

export type DesignNode = {
  id: string;
  name: string;
  type: string;
  parent: string | null;
  depth: number;
  box: Box;
  children: string[];
  /** INSTANCE: component name */
  component?: string | null;
  text?: DesignText;
  layout?: DesignLayout;
  visual?: DesignVisual;
};

export type DesignSpec = {
  schema: 1;
  frameId: string;
  frameName: string;
  /** frame width × design height */
  size: { w: number; h: number };
  /** test viewport (DesignFrame.viewport) */
  viewport: { w: number; h: number };
  nodes: DesignNode[];
};
