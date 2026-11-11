/** Public types of @figtest/figma (contract with the worker: keep the names and fields). */

/**
 * A node in the shape of the Figma REST API (GET /v1/files/:key): .fig files are converted to it, so the rest of the
 * package works the same for both sources. Instances are expanded (children copied from their component, overrides
 * applied, ids "I<instance>;<child>" like the REST API).
 */
export type FigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  [key: string]: unknown;
};

/** A design read from a .fig file or the REST API. */
export interface DesignDocument {
  source: "fig" | "rest";
  fileName: string;
  /** REST: the file key; .fig: null */
  fileKey: string | null;
  /** REST: file version; .fig: its lastModified or "" */
  version: string;
  /** CANVAS nodes (pages) with their children */
  pages: FigmaNode[];
  /** bytes of an image fill (imageRef / hash), null when the file does not have it */
  image(ref: string): Promise<Buffer | null>;
  /** components of the instances (INSTANCE.componentId → component), like the REST `components` map */
  components?: Record<string, DesignComponent>;
  /** component sets (DesignComponent.componentSetId → set), like the REST `componentSets` map */
  componentSets?: Record<string, { key: string; name: string; description?: string }>;
}

/** A component (main component of instances); a variant has the id of its component set. */
export interface DesignComponent {
  key: string;
  name: string;
  description?: string;
  componentSetId?: string;
}

/** A page or a section (sections nest: parentNodeId is the page or the outer section). */
export interface DesignGroup {
  nodeId: string;
  parentNodeId: string | null;
  kind: "page" | "section";
  name: string;
  /** order in its parent */
  position: number;
}

/** A frame that is a screen of the design: a top-level frame of a page, or a frame directly in a section. */
export interface DesignFrame {
  nodeId: string;
  /** the page or the innermost section it is in */
  groupNodeId: string;
  name: string;
  position: number;
  /** frame box */
  width: number;
  height: number;
  /** height of its design: a frame without clip content goes to the bottom of its content, a prototype-scrolling one
   * (overflowDirection *VERTICAL*) to the bottom of what scrolls; at most 16000 */
  designHeight: number;
  scrolls: boolean;
  /** browser viewport of the test: width × (scrolls ? frame height : design height, capped at 16000) */
  viewport: { w: number; h: number };
  /** sha256 hex of the frame subtree (ids excluded where they change on copy) and the image refs it uses: same hash = same design */
  contentHash: string;
  /** a draft: name like draft / old / wip / copy / "ver" / "-2-2-2" chains, or hidden; also a frame in a draft
   * section, or too small to be a screen (label, sticky note). The rules: frames.ts */
  draft: boolean;
  /** node id of an earlier frame with the same name and the same content hash */
  duplicateOf: string | null;
  /** the frame node as read */
  node: FigmaNode;
}

export interface RestOptions {
  /** personal access token (header X-Figma-Token); never logged */
  token: string;
  /** only this node (a page, a section or a frame) and what is in it */
  nodeId?: string | null;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** for tests */
  fetch?: typeof fetch;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  /** fonts that fell back, images missing ... */
  warnings: string[];
}
