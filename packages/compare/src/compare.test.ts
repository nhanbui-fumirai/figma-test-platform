import type { Check, CompareReport, TextResult } from "@figtest/contracts";
import type { DesignLayout, DesignNode, DesignSpec, DesignText, DesignVisual } from "@figtest/figma";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectDom, compareDesign, DEFAULT_TOLERANCES, reportStatus, type DomSnapshot } from "./index";

// ------------------------------------------------------------------ a hand-made spec
type Def = {
  id: string;
  name?: string;
  type?: string;
  box: [number, number, number, number];
  text?: Partial<DesignText> & { characters: string };
  layout?: DesignLayout;
  visual?: Partial<DesignVisual>;
  children?: Def[];
};

function buildSpec(root: Def, viewport = { w: 800, h: 700 }): DesignSpec {
  const nodes: DesignNode[] = [];
  const walk = (d: Def, parent: string | null, depth: number) => {
    const [x, y, w, h] = d.box;
    const node: DesignNode = {
      id: d.id, name: d.name ?? d.text?.characters.slice(0, 30) ?? d.id, type: d.type ?? (d.text ? "TEXT" : "FRAME"),
      parent, depth, box: { x, y, w, h }, children: (d.children ?? []).map((c) => c.id),
    };
    if (d.text) {
      node.text = {
        fontFamily: "Arial", fontWeight: 400, fontSize: 16, lineHeight: 24, lineHeightAuto: false, letterSpacing: 0, color: "#333333",
        decoration: "none", textCase: "none", align: "left", autoResize: "HEIGHT", lines: 1, mixed: false,
        paragraphs: d.text.characters.split("\n"), ...d.text,
      };
    }
    if (d.layout) node.layout = d.layout;
    if (d.visual) node.visual = { fill: null, gradient: false, image: false, stroke: null, radius: null, opacity: 1, shadow: false, ...d.visual };
    nodes.push(node);
    for (const c of d.children ?? []) walk(c, d.id, depth + 1);
  };
  walk(root, null, 0);
  return { schema: 1, frameId: root.id, frameName: root.name ?? root.id, size: { w: root.box[2], h: root.box[3] }, viewport, nodes };
}

const text = (id: string, box: Def["box"], t: Def["text"]): Def => ({ id, box, text: t });

const SPEC = buildSpec({
  id: "1:1", name: "Home", box: [0, 0, 800, 700], visual: { fill: "#FFFFFF" },
  children: [
    text("t:h1", [40, 40, 480, 40], { characters: "Welcome to Furniro", fontSize: 32, lineHeight: 40, fontWeight: 700 }),
    text("t:sub", [40, 96, 480, 24], { characters: "Discover modern furniture for every room", color: "#666666" }), // DOM: 18px
    text("t:ship", [40, 132, 480, 20], { characters: "Free shipping on all orders", fontSize: 14, lineHeight: 20, color: "#B88E2F" }), // DOM: red
    text("t:room", [40, 176, 480, 28], { characters: "Shop by room", fontSize: 20, lineHeight: 28, fontWeight: 600 }), // DOM: 16 px lower
    {
      id: "2:1", name: "Card", box: [40, 228, 320, 108],
      layout: { mode: "VERTICAL", gap: 8, padding: { t: 24, r: 24, b: 24, l: 24 } },
      visual: { fill: "#F9F1E7", radius: 16 }, // DOM: white, radius 4
      children: [
        text("t:sofa", [64, 252, 272, 28], { characters: "Asgaard sofa", fontSize: 20, lineHeight: 28, fontWeight: 600, color: "#3A3A3A" }),
        text("t:price", [64, 288, 272, 24], { characters: "Rs. 250,000.00", fontWeight: 500, color: "#B0B0B0" }),
      ],
    },
    {
      id: "3:1", name: "Button", type: "INSTANCE", box: [40, 360, 160, 48],
      layout: { mode: "HORIZONTAL", gap: 0, padding: { t: 12, r: 32, b: 12, l: 32 } },
      visual: { fill: "#B88E2F", radius: 8 },
      children: [text("t:buy", [72, 372, 96, 24], { characters: "Buy now", fontWeight: 600, color: "#FFFFFF", align: "center" })],
    },
    text("t:offer", [560, 40, 200, 24], { characters: "Limited offer" }), // not in the DOM
    text("t:ana", [560, 100, 200, 24], { characters: "ＡＮＡ ＳＫＹ コイン" }), // DOM: half-width
    text("t:comfort", [560, 160, 200, 48], { characters: "Comfort first.\nMade to last.", lines: 2 }), // DOM: two <p> apart
    text("t:lines", [560, 220, 200, 48], { characters: "Line one.\nLine two.", lines: 2 }), // DOM: two <p> in one <div>
    text("t:one", [560, 300, 10, 24], { characters: "1", autoResize: "WIDTH_AND_HEIGHT" }),
    text("t:x", [700, 300, 12, 24], { characters: "X", autoResize: "WIDTH_AND_HEIGHT" }), // DOM: only far away
  ],
});

const PAGE = `<!doctype html><html><head><style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial; color: #333333; background: #FFFFFF; }
  p, h1, h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 400; }
  .col { position: absolute; left: 40px; top: 40px; width: 480px; }
  .abs { position: absolute; }
</style></head><body>
  <div class="col">
    <h1 style="font-size:32px;line-height:40px;font-weight:700">Welcome to Furniro</h1>
    <p style="margin-top:16px;font-size:18px;color:#666666">Discover modern furniture for every room</p>
    <p style="margin-top:12px;font-size:14px;line-height:20px;color:#FF0000">Free shipping on all orders</p>
    <h2 style="margin-top:40px;font-size:20px;line-height:28px;font-weight:600">Shop by room</h2>
    <div class="card" style="margin-top:24px;width:320px;padding:24px;background:#FFFFFF;border-radius:4px">
      <p style="font-size:20px;line-height:28px;font-weight:600;color:#3A3A3A">Asgaard sofa</p>
      <p style="margin-top:8px;font-weight:500;color:#B0B0B0">Rs. 250,000.00</p>
    </div>
    <button style="display:block;margin-top:24px;width:160px;height:48px;padding:12px 32px;border:none;border-radius:8px;background:#B88E2F;
      color:#FFFFFF;font:600 16px/24px Arial">Buy now</button>
  </div>
  <p class="abs" style="left:560px;top:100px;width:200px">ANA SKY コイン</p>
  <div class="abs" style="left:560px;top:160px;width:200px">
    <p>Comfort first.</p>
    <div><p>Made to last.</p><a href="#">More</a></div>
  </div>
  <div class="abs" style="left:560px;top:220px;width:200px"><p>Line one.</p><p>Line two.</p></div>
  <span class="abs" style="left:560px;top:300px;line-height:24px">1</span>
  <span class="abs" style="left:40px;top:620px;line-height:24px">1</span>
  <span class="abs" style="left:300px;top:650px;line-height:24px">X</span>
</body></html>`;

// ------------------------------------------------------------------ helpers
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function snapshot(html: string, viewport = { width: 800, height: 700 }): Promise<DomSnapshot> {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html);
    return await collectDom(page);
  } finally {
    await page.close();
  }
}

const byNode = (r: CompareReport, node: string, part?: number): TextResult => {
  const t = r.texts.find((x) => x.node === node && x.part === part);
  if (!t) throw new Error(`no text result for ${node}${part === undefined ? "" : ` part ${part}`}`);
  return t;
};
const check = (checks: Check[], prop: string): Check => {
  const c = checks.find((x) => x.prop === prop);
  if (!c) throw new Error(`no check ${prop} in ${checks.map((x) => x.prop).join(", ")}`);
  return c;
};
const failed = (checks: Check[]) => checks.filter((c) => c.status === "fail").map((c) => c.prop);

// ------------------------------------------------------------------ tests
describe("compareDesign on a page with planted differences", () => {
  let dom: DomSnapshot;
  let report: CompareReport;
  beforeAll(async () => {
    dom = await snapshot(PAGE);
    report = compareDesign(SPEC, dom, { url: "http://shop.test/" });
  });

  it("fills the frame, url, page and tolerances", () => {
    expect(report.schema).toBe(1);
    expect(report.frame).toEqual({ id: "1:1", name: "Home", size: { w: 800, h: 700 } });
    expect(report.url).toBe("http://shop.test/");
    expect(report.page).toEqual(dom.page);
    expect(report.tolerances).toEqual(DEFAULT_TOLERANCES);
  });

  it("passes the texts that are like the design", () => {
    for (const node of ["t:h1", "t:room", "t:sofa", "t:price", "t:buy"]) {
      const t = byNode(report, node);
      expect(failed(t.checks), node).toEqual([]);
      expect(t.status, node).toBe("pass");
      expect(t.match, node).toBe("own");
      expect(t.dom?.box.x).toBeGreaterThan(0);
    }
    const h1 = byNode(report, "t:h1");
    expect(check(h1.checks, "lineHeight")).toMatchObject({ expected: 40, actual: 40, status: "pass" });
    expect(check(h1.checks, "fontWeight")).toMatchObject({ expected: 700, actual: 700, status: "pass" });
    expect(check(h1.checks, "position").status).toBe("info");
  });

  it("reports a wrong font size", () => {
    const t = byNode(report, "t:sub");
    expect(t.status).toBe("fail");
    expect(failed(t.checks)).toEqual(["fontSize"]);
    expect(check(t.checks, "fontSize")).toMatchObject({ expected: 16, actual: 18, diff: 2 });
  });

  it("reports a wrong color", () => {
    const t = byNode(report, "t:ship");
    expect(failed(t.checks)).toEqual(["color"]);
    expect(check(t.checks, "color")).toMatchObject({ expected: "#B88E2F", actual: "#FF0000" });
  });

  it("reports a missing text, and a short text only found far from its place", () => {
    const offer = byNode(report, "t:offer");
    expect(offer.status).toBe("missing");
    expect(offer.dom).toBeUndefined();
    expect(offer.checks[0]).toMatchObject({ prop: "missing", status: "fail" });
    expect(byNode(report, "t:x").status).toBe("missing");
  });

  it("matches a short text near its Figma position, not the same text elsewhere", () => {
    const one = byNode(report, "t:one");
    expect(one.status).toBe("pass");
    expect(Math.abs(one.dom!.box.x - 560)).toBeLessThanOrEqual(1);
    expect(Math.abs(one.dom!.box.y - 300)).toBeLessThanOrEqual(1);
  });

  it("matches full-width Figma text with half-width DOM text (loose), and says how it differs", () => {
    const t = byNode(report, "t:ana");
    expect(t.match).toBe("loose");
    expect(t.dom?.text).toBe("ANA SKY コイン");
    expect(check(t.checks, "text")).toMatchObject({ status: "fail", note: "same text in other full-width / half-width characters" });
    expect(failed(t.checks)).toEqual(["text"]);
  });

  it("matches a multi-paragraph text paragraph by paragraph, or as one block", () => {
    const p0 = byNode(report, "t:comfort", 0), p1 = byNode(report, "t:comfort", 1);
    expect([p0.text, p1.text]).toEqual(["Comfort first.", "Made to last."]);
    expect([p0.status, p1.status]).toEqual(["pass", "pass"]);
    expect(Math.abs(p1.dom!.box.y - p0.dom!.box.y - 24)).toBeLessThanOrEqual(1);
    expect(report.texts.some((x) => x.node === "t:comfort" && x.part === undefined)).toBe(false);

    const block = byNode(report, "t:lines");
    expect(block.match).toBe("block");
    expect(block.status).toBe("pass");
    expect(check(block.checks, "lines")).toMatchObject({ expected: 2, actual: 2, status: "pass" });
  });

  it("reports a wrong vertical gap between two texts, and passes the right ones", () => {
    const gap = report.spacing.find((s) => s.from.node === "t:ship" && s.to.node === "t:room");
    expect(gap?.check).toMatchObject({ prop: "verticalSpace", expected: 24, actual: 40, status: "fail" });
    const ok = report.spacing.filter((s) => s !== gap);
    expect(ok.length).toBeGreaterThanOrEqual(5);
    for (const s of ok) expect(s.check.status, `${s.from.text} → ${s.to.text}`).toBe("pass");
    expect(report.summary.spacingFails).toBe(1);
  });

  it("reports the wrong background and radius of a container, and passes its size, insets and gap", () => {
    const card = report.containers.find((c) => c.node === "2:1");
    expect(card).toBeDefined();
    expect(card!.confidence).toBe("high");
    expect(card!.dom?.sel).toBe("div.card");
    expect(card!.status).toBe("fail");
    expect(failed(card!.checks).sort()).toEqual(["background", "radius"]);
    expect(check(card!.checks, "background")).toMatchObject({ expected: "#F9F1E7", actual: "#FFFFFF" });
    expect(check(card!.checks, "radius")).toMatchObject({ expected: 16, actual: 4 });
    for (const prop of ["width", "height", "insetTop", "insetBottom", "insetLeft", "gap"]) expect(check(card!.checks, prop).status, prop).toBe("pass");
  });

  it("passes a container like the design", () => {
    const button = report.containers.find((c) => c.node === "3:1");
    expect(button?.dom?.sel).toBe("button");
    expect(failed(button!.checks)).toEqual([]);
    expect(button!.status).toBe("pass");
    for (const prop of ["width", "height", "background", "radius", "insetTop", "insetBottom"]) expect(check(button!.checks, prop).status, prop).toBe("pass");
  });

  it("computes coverage and design score as specified", () => {
    const s = report.summary;
    expect(s.texts).toBe(12 + 1); // 13 Figma texts
    expect(s.missing).toBe(2);
    expect(s.matched).toBe(11);
    expect(s.coverage).toBeCloseTo(11 / 13, 4);
    const all = [...report.texts.filter((t) => t.dom).flatMap((t) => t.checks), ...report.containers.flatMap((c) => c.checks), ...report.spacing.map((x) => x.check)];
    const n = (st: string) => all.filter((c) => c.status === st).length;
    expect(s.checks).toBe(all.length);
    expect(s.failed).toBe(n("fail"));
    expect(s.ignored).toBe(0);
    expect(s.designScore).toBeCloseTo((n("pass") / (all.length - n("ignored") - n("info"))) * 100, 1);
    // fontSize + color + full-width text / background + radius / vertical space
    expect([s.typographyFails, s.containerFails, s.spacingFails]).toEqual([3, 2, 1]);
    expect(s.failed).toBe(6);
    expect(s.designScore).toBeLessThan(100);
    expect(s.designScore).toBeGreaterThan(80);
    expect(reportStatus(report)).toBe("failed");
  });

  it("turns accepted differences into ignored checks", () => {
    const r = compareDesign(SPEC, dom, {
      ignore: [
        { text: "Free shipping on all orders", prop: "color", reason: "brand red, approved" },
        { text: "/^Discover/", prop: "font", reason: "bigger on purpose" },
        { node: "1:1", prop: "missing", reason: "not in this release" },
        { node: "2:1", reason: "card restyled" },
        { prop: "verticalSpace", reason: "spacing ok" },
        { text: "ＡＮＡ ＳＫＹ コイン", reason: "half-width is fine" },
      ],
    });
    expect(byNode(r, "t:ship").status).toBe("ignored");
    expect(check(byNode(r, "t:ship").checks, "color")).toMatchObject({ status: "ignored", reason: "brand red, approved" });
    expect(check(byNode(r, "t:sub").checks, "fontSize").status).toBe("ignored");
    expect(byNode(r, "t:offer").status).toBe("ignored");
    expect(r.containers.find((c) => c.node === "2:1")?.status).toBe("ignored");
    expect(r.summary).toMatchObject({ failed: 0, missing: 0, texts: 11, matched: 11, coverage: 1, designScore: 100 });
    expect(r.summary.ignored).toBe(6);
    expect(reportStatus(r)).toBe("passed");
  });

  it("uses the tolerances given", () => {
    const r = compareDesign(SPEC, dom, { tolerances: { fontSize: 2, color: 255 } });
    expect(r.tolerances.fontSize).toBe(2);
    expect(r.tolerances.position).toBe(DEFAULT_TOLERANCES.position);
    expect(check(byNode(r, "t:sub").checks, "fontSize").status).toBe("pass");
    expect(check(byNode(r, "t:ship").checks, "color").status).toBe("pass");
  });
});

// ------------------------------------------------------------------ scoring on a synthetic DOM (no browser)
describe("summary semantics", () => {
  const spec = buildSpec({
    id: "0:1", box: [0, 0, 400, 300],
    children: [{ id: "0:2", box: [0, 0, 400, 100], children: [text("0:3", [10, 10, 200, 24], { characters: "Hello world" })] }],
  });
  const el = (i: number, p: number, extra: Partial<DomSnapshot["elements"][number]> = {}): DomSnapshot["elements"][number] => ({
    i, p, tag: i ? "p" : "body", sel: i ? "p" : "body", path: i ? "body > p:nth-child(1)" : "body", box: i ? { x: 10, y: 10, w: 200, h: 24 } : { x: 0, y: 0, w: 400, h: 300 },
    bg: null, bgImage: false, img: false, border: { t: 0, r: 0, b: 0, l: 0, color: null }, radius: 0, padding: { t: 0, r: 0, b: 0, l: 0 },
    gap: { row: 0, col: 0 }, display: "block", flexDirection: "row", opacity: 1, ...extra,
  });
  const domWith = (fontSize: number, own = "Hello world"): DomSnapshot => ({
    url: "about:blank", title: "", viewport: { w: 400, h: 300 }, page: { w: 400, h: 300 },
    elements: [el(0, -1), el(1, 0, {
      text: {
        own, full: null, box: { x: 10, y: 10, w: 90, h: 24 }, glyph: { x: 10, y: 13, w: 90, h: 18 }, lines: 1, fontFamily: "Arial", fontWeight: 400,
        fontSize, lineHeight: 24, lineHeightNormal: false, letterSpacing: 0, color: "#333333", decoration: "none", transform: "none", align: "left", fontStatus: "system",
      },
    })],
  });

  it("design score = passed / (checks - ignored - info)", () => {
    const r = compareDesign(spec, domWith(18));
    // text, fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, color, decoration, lines + position (info)
    expect(r.texts[0]!.checks).toHaveLength(10);
    expect(r.summary).toMatchObject({ texts: 1, matched: 1, missing: 0, coverage: 1, checks: 10, failed: 1, ignored: 0, typographyFails: 1 });
    expect(r.summary.designScore).toBe(88.9); // 8 / 9
    const ign = compareDesign(spec, domWith(18), { ignore: [{ node: "0:2", prop: "fontSize", reason: "ok" }] });
    expect(ign.summary).toMatchObject({ checks: 10, failed: 0, ignored: 1, designScore: 100 });
    expect(reportStatus(ign)).toBe("passed");
  });

  it("missing texts lower the coverage, not the design score", () => {
    const r = compareDesign(spec, domWith(16, "Something else"));
    expect(r.summary).toMatchObject({ texts: 1, matched: 0, missing: 1, coverage: 0, checks: 0, failed: 0, designScore: 100 });
    expect(reportStatus(r)).toBe("failed");
  });

  it("no texts: coverage 1, design score 100", () => {
    const empty = buildSpec({ id: "9:1", box: [0, 0, 100, 100] });
    const r = compareDesign(empty, domWith(16));
    expect(r.summary).toMatchObject({ texts: 0, matched: 0, coverage: 1, designScore: 100, checks: 0 });
    expect(reportStatus(r)).toBe("passed");
  });

  /** a DOM of positioned texts under body */
  const synth = (items: { own: string; x: number; y: number; w?: number; fontSize?: number }[]): DomSnapshot => ({
    url: "about:blank", title: "", viewport: { w: 1000, h: 800 }, page: { w: 1000, h: 800 },
    elements: [el(0, -1), ...items.map((t, k) => el(k + 1, 0, {
      box: { x: t.x, y: t.y, w: t.w ?? 100, h: 24 },
      text: {
        own: t.own, full: null, box: { x: t.x, y: t.y, w: t.w ?? 100, h: 24 }, glyph: { x: t.x, y: t.y + 3, w: t.w ?? 100, h: 18 }, lines: 1, fontFamily: "Arial",
        fontWeight: 400, fontSize: t.fontSize ?? 16, lineHeight: 24, lineHeightNormal: false, letterSpacing: 0, color: "#333333", decoration: "none",
        transform: "none", align: "left", fontStatus: "system",
      },
    }))],
  });

  it("fuzzy: a text with a typo is matched and reported", () => {
    const s = buildSpec({ id: "0:1", box: [0, 0, 1000, 800], children: [text("f", [10, 10, 300, 24], { characters: "Free shiping on all orders" })] });
    const r = compareDesign(s, synth([{ own: "Free shipping on all orders", x: 10, y: 10 }, { own: "Something else entirely", x: 10, y: 50 }]));
    expect(r.texts[0]).toMatchObject({ match: "fuzzy", status: "fail" });
    expect(check(r.texts[0]!.checks, "text")).toMatchObject({ status: "fail", actual: "Free shipping on all orders" });
    expect(check(r.texts[0]!.checks, "text").note).toMatch(/% alike/);
    expect(r.summary.coverage).toBe(1);
  });

  it("part: short Figma texts inside one longer DOM text near them", () => {
    const s = buildSpec({
      id: "0:1", box: [0, 0, 1000, 800],
      children: [text("x", [10, 10, 10, 24], { characters: "X", autoResize: "WIDTH_AND_HEIGHT" }), text("n", [30, 10, 10, 24], { characters: "1", autoResize: "WIDTH_AND_HEIGHT" })],
    });
    const r = compareDesign(s, synth([{ own: "X 1", x: 10, y: 10, w: 30 }, { own: "X 1", x: 600, y: 600, w: 30 }]));
    expect(r.texts.map((t) => [t.text, t.match, t.status, t.dom?.box.x])).toEqual([["X", "part", "pass", 10], ["1", "part", "pass", 10]]);
  });

  it("the same text twice: each Figma text gets the DOM text nearest to it", () => {
    const s = buildSpec({
      id: "0:1", box: [0, 0, 1000, 800],
      children: [text("top", [10, 10, 100, 24], { characters: "Home" }), text("bottom", [10, 700, 100, 24], { characters: "Home", fontSize: 12 })],
    });
    const r = compareDesign(s, synth([{ own: "Home", x: 10, y: 690, fontSize: 12 }, { own: "Home", x: 10, y: 20 }]));
    expect(r.texts.map((t) => [t.node, t.dom?.box.y, t.status])).toEqual([["top", 20, "pass"], ["bottom", 690, "pass"]]);
  });

  it("containers: low confidence → info checks; no element close in size or no text found → unmatched with a reason", () => {
    const s = buildSpec({
      id: "0:1", box: [0, 0, 1000, 800],
      children: [
        { id: "A", name: "Box A", box: [0, 0, 300, 100], visual: { fill: "#EEEEEE" }, children: [text("ta", [20, 20, 200, 24], { characters: "Inside box A" })] },
        { id: "B", name: "Box B", box: [0, 200, 300, 100], visual: { fill: "#EEEEEE" }, children: [text("tb", [20, 220, 200, 24], { characters: "Inside box B" })] },
        { id: "C", name: "Box C", box: [0, 400, 300, 100], visual: { fill: "#EEEEEE" }, children: [text("tc", [20, 420, 200, 24], { characters: "Not on the page" })] },
      ],
    });
    const dom = synth([{ own: "Inside box A", x: 20, y: 20 }, { own: "Inside box B", x: 20, y: 220 }]);
    // a wrapper of 300 × 140 around text A (40 % taller: low confidence); text B sits right in body (1000 × 800)
    dom.elements.push(el(3, 0, { box: { x: 0, y: 0, w: 300, h: 140 }, bg: "#EEEEEE" }));
    dom.elements[1]!.p = 3;
    const r = compareDesign(s, dom);
    const a = r.containers.find((c) => c.node === "A")!;
    expect(a).toMatchObject({ confidence: "low", status: "pass" });
    expect(a.checks.every((c) => c.status === "info")).toBe(true);
    expect(check(a.checks, "height").note).toMatch(/differs, not scored/);
    expect(r.unmatchedContainers.map((u) => [u.node, u.reason])).toEqual([
      ["B", "closest element of the page p is 100×24, Figma 300×100"],
      ["C", "none of its 1 text(s) is on the page"],
    ]);
    expect(r.summary.unmatchedContainers).toBe(2);
  });

  it("stays fast on a big page", () => {
    const items = Array.from({ length: 4000 }, (_, k) => ({ own: `Product number ${k} with a long enough description ${k * 7}`, x: (k % 4) * 250, y: Math.floor(k / 4) * 30 }));
    const children = Array.from({ length: 300 }, (_, k) => text(`n${k}`, [(k % 4) * 250, Math.floor(k / 4) * 30, 240, 24], { characters: k % 2 ? `Product number ${k} with a long enough description ${k * 7}` : `Missing label ${k} that the page does not have` }));
    const s = buildSpec({ id: "0:1", box: [0, 0, 1000, 30_000], children });
    const t0 = Date.now();
    const r = compareDesign(s, synth(items));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.summary).toMatchObject({ texts: 300, matched: 150, missing: 150 });
  });

  it("text case vs text-transform", () => {
    const upper = buildSpec({ id: "0:1", box: [0, 0, 400, 300], children: [text("0:3", [10, 10, 200, 24], { characters: "Shop now", textCase: "upper" })] });
    const dom = domWith(16, "shop now");
    dom.elements[1]!.text!.transform = "uppercase";
    expect(check(compareDesign(upper, dom).texts[0]!.checks, "textCase")).toMatchObject({ expected: "SHOP NOW", actual: "SHOP NOW", status: "pass" });
    dom.elements[1]!.text!.transform = "capitalize";
    expect(check(compareDesign(upper, dom).texts[0]!.checks, "textCase")).toMatchObject({ actual: "Shop Now", status: "fail" });
  });
});
