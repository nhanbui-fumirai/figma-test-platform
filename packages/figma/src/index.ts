/**
 * @figtest/figma: reads a Figma design (.fig file or REST API) into one REST-shaped tree, lists its pages, sections and
 * frames, and gives each frame its design: the spec (what the compare engine checks) and an image (renderer).
 *
 * PUBLIC CONTRACT: the worker codes against the exports below. Implementations live in the other files of src/.
 */
export type { FigmaNode, DesignDocument, DesignGroup, DesignFrame, RestOptions, RenderResult, DesignComponent } from "./types";
export type { DesignSpec, DesignNode, DesignText, DesignLayout, DesignVisual } from "./spec-types";

export { readFigFile } from "./fig";
export { parseFigmaUrl, readFigmaFile } from "./rest";
export { listDesign } from "./frames";
export { extractSpec } from "./spec";
export { FrameRenderer, makeThumbnail } from "./render";
