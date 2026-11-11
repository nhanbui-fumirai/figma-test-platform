import { createHash, type Hash } from "node:crypto";
import { designHeight, designViewport, scrollsDown } from "./area";
import type { DesignDocument, DesignFrame, DesignGroup, FigmaNode } from "./types";
import { type AnyNode, boxOf, childrenOf, r2 } from "./util";

/**
 * Node types that are a screen when they sit at the top of a page or directly in a section. A COMPONENT_SET is a set of
 * variants of a UI part (buttons, cards): neither it nor its variants are screens.
 */
export const SCREEN_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);

/**
 * Drafts. Conservative: a frame is a draft only when something says so, a frame named like a real screen never is.
 *   1. hidden (visible false)
 *   2. its name marks it as not final: draft, wip, old, copy, backup, bk, bak, tmp, temp, test, archive, unused,
 *      deprecated, obsolete (as words: "Bold", "Contest", "testimonials" are not), an old version ("旧ver", "old ver";
 *      not "Ver2": often the current one), Japanese markers (コピー, 旧 as a prefix or in brackets, 没, ボツ, 不要, 初稿,
 *      修正前, 検討中), "削除" only as a marker (【削除】, 削除予定, 要削除: "航空券の削除" is a real screen; "(仮)" is a
 *      provisional name, not a draft), or a "-2-2" chain of copy suffixes
 *   3. it is in a section named like a draft space (the markers above, plus 検討, スコープアウト, アーカイブ)
 *   4. it is too small to be a screen: under 100 px wide or high (labels, sticky notes, annotation strips)
 *   5. it lies outside the sections of a page whose screens are nearly all in sections (at least 5, and 90 % of
 *      them): the ones left on the canvas next to them are leftovers
 */
const WORDS = /(?<![a-z0-9])(draft|wip|old|copy|backup|bk|bak|tmp|temp|test|archive|archived|unused|deprecated|obsolete)(?![a-z])/i;
const OLD_VERSION = /(旧|old|前|prev(ious)?)[\s_.-]*ver(sion)?(?![a-z])/i;
const JA = /コピー|^旧|[\s_【\[(（]旧|旧[\s_】\])）]|没|ボツ|不要|初稿|修正前|検討中/;
const DELETE_MARK = /[【\[(（]\s*削除|削除\s*[】\])）]|削除予定|削除済|要削除/;
const COPY_CHAIN = /([-_ ]\d{1,2})\1+$/;
const DRAFT_SECTION = /検討|スコープアウト|アーカイブ/;

export function draftName(name: string): boolean {
  return WORDS.test(name) || OLD_VERSION.test(name) || JA.test(name) || DELETE_MARK.test(name) || COPY_CHAIN.test(name.trim());
}
const draftSection = (name: string) => draftName(name) || DRAFT_SECTION.test(name);

const MIN_SCREEN = 100;
const tooSmall = (n: AnyNode) => {
  const b = boxOf(n);
  return !!b && (b.width < MIN_SCREEN || b.height < MIN_SCREEN);
};

/** Pages, sections (nested) and the frames that are screens, in document order. */
export function listDesign(doc: DesignDocument): { groups: DesignGroup[]; frames: DesignFrame[] } {
  const groups: DesignGroup[] = [];
  const frames: DesignFrame[] = [];

  type Found = { node: AnyNode; group: string; position: number; draftSpace: boolean; inSection: boolean; page: string };
  const found: Found[] = [];
  const walk = (container: AnyNode, groupId: string, page: string, draftSpace: boolean, inSection: boolean) => {
    let sections = 0;
    let screens = 0;
    for (const c of childrenOf(container)) {
      if (c.type === "SECTION") {
        groups.push({ nodeId: c.id, parentNodeId: groupId, kind: "section", name: c.name ?? "", position: sections++ });
        walk(c, c.id, page, draftSpace || draftSection(c.name ?? "") || c.visible === false, true);
      } else if (SCREEN_TYPES.has(c.type) && boxOf(c)) {
        found.push({ node: c, group: groupId, position: screens++, draftSpace, inSection, page });
      }
    }
  };
  doc.pages.forEach((page, i) => {
    groups.push({ nodeId: page.id, parentNodeId: null, kind: "page", name: page.name ?? "", position: i });
    walk(page, page.id, page.id, false, false);
  });

  // rule 5: pages whose screens are nearly all in sections
  const perPage = new Map<string, { inSections: number; loose: number }>();
  for (const f of found) {
    if (tooSmall(f.node)) continue;
    const s = perPage.get(f.page) ?? { inSections: 0, loose: 0 };
    if (f.inSection) s.inSections++;
    else s.loose++;
    perPage.set(f.page, s);
  }
  const sectionPage = (page: string) => {
    const s = perPage.get(page);
    return !!s && s.inSections >= 5 && s.inSections >= 0.9 * (s.inSections + s.loose);
  };

  const firstOf = new Map<string, string>();
  for (const f of found) {
    const n = f.node;
    const b = boxOf(n)!;
    const contentHash = frameHash(n);
    const draft = n.visible === false || draftName(n.name ?? "") || f.draftSpace || tooSmall(n) || (!f.inSection && sectionPage(f.page));
    const key = `${n.name ?? ""}\u0000${contentHash}`;
    const duplicateOf = firstOf.get(key) ?? null;
    if (!duplicateOf) firstOf.set(key, n.id);
    frames.push({
      nodeId: n.id,
      groupNodeId: f.group,
      name: n.name ?? "",
      position: f.position,
      width: r2(b.width),
      height: r2(b.height),
      designHeight: designHeight(n),
      scrolls: scrollsDown(n),
      viewport: designViewport(n),
      contentHash,
      draft,
      duplicateOf,
      node: n as FigmaNode,
    });
  }
  return { groups, frames };
}

// ---------------------------------------------------------------- content hash

/** Fields left out of the hash: ids change when a frame is copied, plugin data is not design. */
const SKIP = new Set(["id", "children", "absoluteBoundingBox", "absoluteRenderBounds", "pluginData", "sharedPluginData"]);
/** Of the frame itself: where it is on the canvas and its name (a rename is not a design change). */
const SKIP_ROOT = new Set([...SKIP, "name", "relativeTransform"]);

/**
 * sha256 hex of the frame subtree, the same for an unchanged frame whatever its place on the canvas or its ids (a
 * copy of a frame has the same hash): canonical JSON (sorted keys) of every node without its id, boxes relative to the
 * frame, then the image refs it uses. References to other nodes (componentId, prototype destinations, styles) stay.
 */
export function frameHash(frame: AnyNode): string {
  const h: Hash = createHash("sha256");
  // the canonical JSON is written in chunks (one update per piece is slow on big frames)
  let buf = "";
  const put = (s: string) => {
    buf += s;
    if (buf.length > 65536) {
      h.update(buf);
      buf = "";
    }
  };
  const origin = boxOf(frame) ?? { x: 0, y: 0, width: 0, height: 0 };
  const images = new Set<string>();
  const node = (n: AnyNode, root: boolean) => {
    put("{");
    const skip = root ? SKIP_ROOT : SKIP;
    for (const k of Object.keys(n).sort()) {
      if (skip.has(k) || n[k] === undefined) continue;
      put(`${JSON.stringify(k)}:`);
      value(n[k]);
      put(",");
    }
    const b = boxOf(n);
    if (b) put(`"box":[${r2(b.x - origin.x)},${r2(b.y - origin.y)},${r2(b.width)},${r2(b.height)}],`);
    put('"children":[');
    for (const c of childrenOf(n)) {
      node(c, false);
      put(",");
    }
    put("]}");
  };
  const value = (v: unknown): void => {
    if (v === null || typeof v !== "object") {
      put(JSON.stringify(v) ?? "null");
      return;
    }
    if (Array.isArray(v)) {
      put("[");
      for (const x of v) {
        value(x);
        put(",");
      }
      put("]");
      return;
    }
    const o = v as AnyNode;
    put("{");
    for (const k of Object.keys(o).sort()) {
      if (o[k] === undefined) continue;
      if ((k === "imageRef" || k === "gifRef") && typeof o[k] === "string" && o[k]) images.add(o[k]);
      put(`${JSON.stringify(k)}:`);
      value(o[k]);
      put(",");
    }
    put("}");
  };
  node(frame, true);
  put(`\nimages:${[...images].sort().join(",")}`);
  h.update(buf);
  return h.digest("hex");
}
