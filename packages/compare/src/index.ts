/**
 * @figtest/compare: collects the DOM of a page (a script run in the page) and compares it with the spec of a frame:
 * texts matched (coverage), then typography, containers and spacing checked on the matches (design score).
 *
 * PUBLIC CONTRACT: the worker codes against the exports below. Implementations live in the other files of src/.
 */
export type { DomSnapshot, DomElement, DomText, CompareOptions, IgnoreRule } from "./types";
export { COLLECT_DOM_SCRIPT, collectDom } from "./collect";
export { compareDesign, DEFAULT_TOLERANCES, reportStatus } from "./compare";
