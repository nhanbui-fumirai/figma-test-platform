import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectDom, COLLECT_DOM_SCRIPT, type DomElement, type DomSnapshot } from "./index";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});
afterAll(async () => { await browser?.close(); });

const HTML = `<!doctype html><html><head><style>
  body { margin: 0; font-family: Arial; color: #333333; }
  p { margin: 0; }
  .abs { position: absolute; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  @font-face { font-family: "Ghost"; src: url(data:font/woff2;base64,AAAA) format("woff2"); }
</style></head><body>
  <p id="lh" class="abs" style="left:10px;top:20px;font-size:16px;line-height:32px">Hello world</p>
  <p id="wrap" class="abs" style="left:10px;top:100px;width:60px;font-size:16px;line-height:32px">Hello world again</p>
  <p id="normal" class="abs" style="left:10px;top:240px;font-size:16px">Normal line</p>
  <p id="rgba" class="abs" style="left:10px;top:280px;color:rgba(0,0,0,0.5);background:#123456;text-decoration:line-through;text-transform:uppercase;letter-spacing:1.5px">Faded</p>
  <button id="close" class="abs" style="left:300px;top:20px">Close<span class="sr-only">the dialog</span></button>
  <p id="mixed" class="abs" style="left:300px;top:60px">Price <b>100</b> yen</p>
  <a id="link" class="abs" href="#" style="left:300px;top:100px;text-decoration:underline"><span id="inner">Link</span></a>
  <input id="field" class="abs" style="left:300px;top:140px;font:14px/20px Arial;padding:4px 8px" placeholder="Your email">
  <input id="filled" class="abs" style="left:300px;top:180px" value="Tokyo">
  <div id="clip" class="abs" style="left:300px;top:240px;width:120px;height:20px;overflow:hidden"><span>Seen</span><p style="margin-top:40px">Clipped away</p></div>
  <p class="abs" style="left:500px;top:20px;display:none">Not displayed</p>
  <p class="abs" style="left:500px;top:60px;visibility:hidden">Invisible</p>
  <div class="abs" style="left:500px;top:100px;opacity:0"><p>Transparent</p></div>
  <p class="abs" data-figtest-ignore style="left:500px;top:140px">Ignored on purpose</p>
  <p class="abs" style="left:-500px;top:180px">Off canvas</p>
  <svg class="abs" style="left:500px;top:220px" width="20" height="20"><rect width="10" height="10"/><text x="0" y="10">svg</text></svg>
  <p id="ghost" class="abs" style="left:10px;top:330px;font-family:Ghost, Arial">Ghost font</p>
  <p id="nofont" class="abs" style="left:10px;top:360px;font-family:'NoSuchFont 123', Arial">No such font</p>
  <div id="card" class="abs" style="left:10px;top:400px;width:200px;padding:12px 16px;border:2px solid #FF0000;border-radius:50%;background:#00FF00;display:flex;flex-direction:column;gap:6px;box-shadow:0 1px 2px #000">
    <p>One</p><p>Two</p>
  </div>
  <div style="height:2000px"></div>
</body></html>`;

let dom: DomSnapshot;
const byId = async (id: string): Promise<DomElement> => {
  const path = await page.evaluate((x) => {
    const el = document.getElementById(x);
    const parts: string[] = [];
    for (let e: Element | null = el; e && e.parentElement && e !== document.body; e = e.parentElement) {
      parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(e.parentElement.children, e) + 1})`);
    }
    return ["body", ...parts].join(" > ");
  }, id);
  const found = dom.elements.find((e) => e.path === path);
  if (!found) throw new Error(`#${id} (${path}) not collected`);
  return found;
};
const texts = () => dom.elements.flatMap((e) => (e.text ? [e.text.own, e.text.full ?? ""] : [])).filter(Boolean);

describe("COLLECT_DOM_SCRIPT", () => {
  beforeAll(async () => {
    await page.setContent(HTML);
    dom = await collectDom(page);
  });

  it("is a self-contained expression that returns a snapshot", async () => {
    expect(typeof COLLECT_DOM_SCRIPT).toBe("string");
    const again = (await page.evaluate(COLLECT_DOM_SCRIPT)) as DomSnapshot;
    expect(again.elements.length).toBe(dom.elements.length);
    expect(dom.viewport).toEqual({ w: 800, h: 600 });
    expect(dom.page.w).toBe(800);
    expect(dom.page.h).toBeGreaterThanOrEqual(2000);
    expect(dom.url).toBe("about:blank");
  });

  it("starts with body, links each element to its nearest collected ancestor, gives paths that find the element", async () => {
    expect(dom.elements[0]).toMatchObject({ i: 0, p: -1, tag: "body", path: "body" });
    dom.elements.forEach((e, k) => { expect(e.i).toBe(k); expect(e.p).toBeLessThan(k); });
    const inner = await byId("inner"), link = await byId("link");
    expect(inner.p).toBe(link.i);
    expect(link.sel).toBe("a#link.abs");
    const tags = await page.evaluate((paths) => paths.map((p) => document.querySelector(p)?.tagName.toLowerCase() ?? null), dom.elements.map((e) => e.path));
    expect(tags).toEqual(dom.elements.map((e) => e.tag));
  });

  it("gives a text with line-height its line box (glyphs grown by the half-leading)", async () => {
    const t = (await byId("lh")).text!;
    expect(t).toMatchObject({ own: "Hello world", full: null, lines: 1, fontSize: 16, lineHeight: 32, lineHeightNormal: false, fontFamily: "Arial", fontWeight: 400 });
    expect(t.box.x).toBe(10);
    expect(Math.abs(t.box.y - 20)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(t.box.h - 32)).toBeLessThanOrEqual(0.5);
    expect(t.glyph.h).toBeLessThan(24);
    expect(t.glyph.y).toBeGreaterThan(t.box.y);
    expect(t.box.w).toBeGreaterThan(60);
    expect(t.box.w).toBeLessThan(110);
  });

  it("counts the lines of a wrapped text, its box = lines × line height", async () => {
    const t = (await byId("wrap")).text!;
    expect(t.lines).toBe(3);
    expect(Math.abs(t.box.y - 100)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(t.box.h - 96)).toBeLessThanOrEqual(0.5);
    expect(t.box.w).toBeLessThanOrEqual(60);
  });

  it("measures line-height normal", async () => {
    const t = (await byId("normal")).text!;
    expect(t.lineHeightNormal).toBe(true);
    expect(t.lineHeight).toBeGreaterThan(16);
    expect(t.lineHeight).toBeLessThan(24);
    expect(Math.abs(t.box.h - t.lineHeight!)).toBeLessThanOrEqual(1);
  });

  it("reads colors, decoration, transform, letter spacing", async () => {
    const e = await byId("rgba");
    expect(e.bg).toBe("#123456");
    expect(e.text).toMatchObject({ color: "#00000080", decoration: "line-through", transform: "uppercase", letterSpacing: 1.5, own: "Faded" });
    expect((await byId("inner")).text?.decoration).toBe("underline"); // propagated from <a>
  });

  it("keeps own text and block text apart, leaves visually hidden text out", async () => {
    expect((await byId("mixed")).text).toMatchObject({ own: "Price yen", full: "Price 100 yen" });
    expect((await byId("close")).text).toMatchObject({ own: "Close", full: null });
    expect((await byId("clip")).text).toMatchObject({ own: "", full: "Seen" });
    const all = texts().join(" | ");
    for (const hidden of ["the dialog", "Clipped away", "Not displayed", "Invisible", "Transparent", "Ignored on purpose", "Off canvas", "svg"]) {
      expect(all).not.toContain(hidden);
    }
    expect(dom.elements.some((e) => e.tag === "rect" || e.tag === "text")).toBe(false);
    expect(dom.elements.some((e) => e.tag === "svg" && e.img)).toBe(true);
  });

  it("reads form fields: placeholder or value, placed in the field", async () => {
    const f = await byId("field");
    expect(f.text).toMatchObject({ own: "Your email", placeholder: true, fontSize: 14, lineHeight: 20, lines: 1 });
    expect(f.text!.box.x).toBeGreaterThanOrEqual(f.box.x + 8);
    expect(f.text!.box.y).toBeGreaterThan(f.box.y);
    expect((await byId("filled")).text).toMatchObject({ own: "Tokyo" });
    expect((await byId("filled")).text?.placeholder).toBeUndefined();
  });

  it("tells loaded / system / missing fonts apart", async () => {
    expect((await byId("lh")).text?.fontStatus).toBe("system");
    expect((await byId("ghost")).text).toMatchObject({ fontFamily: "Ghost", fontStatus: "not-loaded" });
    expect((await byId("nofont")).text).toMatchObject({ fontFamily: "NoSuchFont 123", fontStatus: "not-loaded" });
  });

  it("reads the box of a container", async () => {
    const c = await byId("card");
    expect(c).toMatchObject({
      bg: "#00FF00", display: "flex", flexDirection: "column", gap: { row: 6, col: 6 }, padding: { t: 12, r: 16, b: 12, l: 16 },
      border: { t: 2, r: 2, b: 2, l: 2, color: "#FF0000" }, shadow: true, opacity: 1,
    });
    expect(c.box.w).toBe(236);
    expect(c.radius).toBe(118); // 50 % of the width
  });

  it("gives page coordinates whatever the scroll", async () => {
    await page.evaluate(() => window.scrollTo(0, 300));
    const scrolled = await collectDom(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const a = dom.elements.find((e) => e.text?.own === "Hello world")!, b = scrolled.elements.find((e) => e.text?.own === "Hello world")!;
    expect(b.box).toEqual(a.box);
    expect(b.text!.box).toEqual(a.text!.box);
  });
});
