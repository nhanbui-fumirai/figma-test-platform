/**
 * A frame spec written by the old tool (playwright-figma, anx-db project, frame "2"), trimmed (vector icons left out),
 * converted to the new DesignSpec shape, compared with a page built like it: Japanese texts, a trailing zero-width
 * space in Figma, auto-layout frames, a button instance.
 */
import type { DesignNode, DesignSpec } from "@figtest/figma";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectDom, compareDesign, reportStatus } from "./index";

const MESSAGE = "代表者名が変更されたため、ANA SKYコインの支払い情報がリセットされました。ご利用の場合は「支払者変更」より再度入力してください。";

/** The old shape: source, file key, slug, page, image... and no viewport. */
const LEGACY = {
  schema: 1,
  source: "rest",
  fileKey: "FILEKEY",
  fileName: "anx-db",
  version: "fig-20261103155507",
  extractedAt: "2026-11-07T05:12:50.984Z",
  frameId: "44800:75691",
  frameName: "2親等エラーの場合",
  slug: "2",
  page: "FFL制作",
  size: { w: 375, h: 162 },
  image: "2.png",
  nodes: [
    { id: "44800:75691", name: "2親等エラーの場合", type: "FRAME", parent: null, depth: 0, box: { x: 0, y: 0, w: 375, h: 162 }, children: ["44800:75692"], layout: { mode: "VERTICAL", gap: 10, padding: { t: 10, r: 10, b: 10, l: 10 }, primaryAlign: "MIN", counterAlign: "CENTER" }, visual: { fill: "#FFFFFF", gradient: false, image: false, stroke: null, radius: null, opacity: 1, shadow: false } },
    { id: "44800:75692", name: "Frame 1171280350", type: "FRAME", parent: "44800:75691", depth: 1, box: { x: 10, y: 10, w: 355, h: 142 }, children: ["44800:75693"], layout: { mode: "VERTICAL", gap: 10, padding: { t: 0, r: 0, b: 0, l: 0 }, primaryAlign: "MIN", counterAlign: "MIN" } },
    { id: "44800:75693", name: "Section", type: "FRAME", parent: "44800:75692", depth: 2, box: { x: 10, y: 10, w: 355, h: 142 }, children: ["44800:75694", "44800:75698"], layout: { mode: "VERTICAL", gap: 0.0000152587890625, padding: { t: 0, r: 0, b: 0, l: 0 }, primaryAlign: "MIN", counterAlign: "MIN" } },
    { id: "44800:75694", name: "Container", type: "FRAME", parent: "44800:75693", depth: 3, box: { x: 10, y: 10, w: 355, h: 56 }, children: ["44800:75717", "44800:75713"], layout: { mode: "HORIZONTAL", gap: 8, padding: { t: 0, r: -0.00002288818359375, b: 0, l: 0 }, primaryAlign: "SPACE_EVENLY", counterAlign: "CENTER" } },
    { id: "44800:75717", name: "Frame 1171280580", type: "FRAME", parent: "44800:75694", depth: 4, box: { x: 10, y: 26, w: 121, h: 24 }, children: ["44800:75695", "44800:75696"], layout: { mode: "HORIZONTAL", gap: 8, padding: { t: 0, r: 0, b: 0, l: 0 }, primaryAlign: "MIN", counterAlign: "CENTER" } },
    { id: "44800:75695", name: "Icon", type: "INSTANCE", parent: "44800:75717", depth: 5, box: { x: 10, y: 26, w: 24, h: 24 }, children: [], component: null },
    { id: "44800:75696", name: "Heading 2", type: "FRAME", parent: "44800:75717", depth: 5, box: { x: 42, y: 26, w: 89, h: 24 }, children: ["44800:75697"] },
    { id: "44800:75697", name: "Title", type: "TEXT", parent: "44800:75696", depth: 6, box: { x: 42, y: 26, w: 102, h: 21 }, children: [], text: { characters: "ANA SKY コイン", paragraphs: ["ANA SKY コイン"], fontFamily: "Noto Sans JP", fontWeight: 700, fontSize: 14, lineHeight: 21, lineHeightAuto: false, letterSpacing: -0.15, color: "#333333", decoration: "none", textCase: "none", align: "left", autoResize: "WIDTH_AND_HEIGHT", lines: 1, mixed: false } },
    { id: "44800:75713", name: "Button", type: "INSTANCE", parent: "44800:75694", depth: 4, box: { x: 276, y: 27.5, w: 89, h: 21 }, children: ["I44800:75713;32388:142240", "I44800:75713;32388:142241"], component: null, layout: { mode: "HORIZONTAL", gap: 4, padding: { t: 0, r: 0, b: 0, l: 0 }, primaryAlign: "MIN", counterAlign: "CENTER" }, visual: { fill: null, gradient: false, image: false, stroke: null, radius: 8, opacity: 1, shadow: false } },
    { id: "I44800:75713;32388:142240", name: " 地図", type: "TEXT", parent: "44800:75713", depth: 5, box: { x: 276, y: 27.5, w: 69, h: 21 }, children: [], text: { characters: "支払者変更", paragraphs: ["支払者変更"], fontFamily: "Noto Sans JP", fontWeight: 700, fontSize: 14, lineHeight: 21, lineHeightAuto: false, letterSpacing: -0.28, color: "#00146E", decoration: "none", textCase: "none", align: "center", autoResize: "WIDTH_AND_HEIGHT", lines: 1, mixed: false } },
    { id: "I44800:75713;32388:142241", name: "Icon", type: "INSTANCE", parent: "44800:75713", depth: 5, box: { x: 349, y: 30, w: 16, h: 16 }, children: [], component: null },
    { id: "44800:75698", name: "Frame 1171280351", type: "FRAME", parent: "44800:75693", depth: 3, box: { x: 10, y: 66, w: 355, h: 86 }, children: ["44800:75702"], layout: { mode: "VERTICAL", gap: 16, padding: { t: 16, r: 0, b: 16, l: 0 }, primaryAlign: "MIN", counterAlign: "MIN" } },
    { id: "44800:75702", name: `${MESSAGE}\u{200B}`, type: "TEXT", parent: "44800:75698", depth: 4, box: { x: 10, y: 82, w: 355, h: 54 }, children: [], text: { characters: `${MESSAGE}\u{200B}`, paragraphs: [`${MESSAGE}\u{200B}`], fontFamily: "Noto Sans JP", fontWeight: 500, fontSize: 12, lineHeight: 18, lineHeightAuto: false, letterSpacing: -0.24, color: "#C52431", decoration: "none", textCase: "none", align: "left", autoResize: "HEIGHT", lines: 3, mixed: false } },
  ],
};

/** Old spec → new DesignSpec: same nodes; the file fields go, the viewport comes (the frame size when there is none). */
function fromLegacy(old: typeof LEGACY & { viewport?: { w: number; h: number } }): DesignSpec {
  return {
    schema: 1,
    frameId: old.frameId,
    frameName: old.frameName,
    size: old.size,
    viewport: old.viewport ?? { w: old.size.w, h: old.size.h },
    nodes: old.nodes as DesignNode[],
  };
}

const PAGE = `<!doctype html><html><head><style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Noto Sans JP", sans-serif; color: #333333; background: #FFFFFF; }
  h2, p { margin: 0; }
</style></head><body>
  <div style="padding:10px;width:375px">
    <section>
      <div class="row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;height:56px">
        <div style="display:flex;align-items:center;gap:8px">
          <svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#C6C6C6" stroke-width="2"/></svg>
          <h2 style="font-size:14px;line-height:21px;font-weight:700;letter-spacing:-0.15px;color:#333333">ANA SKY コイン</h2>
        </div>
        <button style="display:flex;align-items:center;gap:4px;padding:0;border:none;background:none;border-radius:8px;font-family:inherit;font-size:14px;line-height:21px;font-weight:700;letter-spacing:-0.28px;color:#00146E">支払者変更<svg width="16" height="16"></svg></button>
      </div>
      <div class="message" style="padding:16px 0">
        <p style="font-size:12px;line-height:18px;font-weight:500;letter-spacing:-0.24px;color:#C52431">${MESSAGE}</p>
      </div>
    </section>
  </div>
</body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

describe("a spec of the old tool, converted", () => {
  it("matches every text and checks its typography", async () => {
    const spec = fromLegacy(LEGACY);
    const page = await browser.newPage({ viewport: { width: spec.viewport.w, height: spec.viewport.h } });
    await page.setContent(PAGE);
    const dom = await collectDom(page);
    await page.close();
    const report = compareDesign(spec, dom, { url: "http://anx.test/2" });

    expect(report.frame).toEqual({ id: "44800:75691", name: "2親等エラーの場合", size: { w: 375, h: 162 } });
    expect(report.summary).toMatchObject({ texts: 3, matched: 3, missing: 0, coverage: 1 });
    expect(report.texts.map((t) => [t.text, t.match, t.dom?.text])).toEqual([
      ["ANA SKY コイン", "own", "ANA SKY コイン"],
      ["支払者変更", "own", "支払者変更"],
      [MESSAGE, "own", MESSAGE], // the trailing zero-width space of Figma is not a difference
    ]);
    for (const t of report.texts) {
      const status = (prop: string) => t.checks.find((c) => c.prop === prop)?.status;
      for (const prop of ["text", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "decoration"]) expect(status(prop), `${t.text} ${prop}`).toBe("pass");
      // without the web font, the page draws a fallback: said, not hidden
      const font = dom.elements[t.dom!.i]!.text!.fontStatus;
      expect(status("fontLoaded")).toBe(font === "not-loaded" ? "fail" : undefined);
    }

    // the button instance and the padded message frame are found in the page
    const button = report.containers.find((c) => c.name === "Button");
    expect(button?.dom?.sel).toBe("button");
    const message = report.containers.find((c) => c.name === "Frame 1171280351");
    expect(message?.dom?.sel).toBe("div.message");
    expect(message?.confidence).toBe("high");
    for (const prop of ["width", "insetTop"]) expect(message?.checks.find((c) => c.prop === prop)?.status, prop).toBe("pass");
    expect(report.containers.find((c) => c.name === "Container")?.dom?.sel).toBe("div.row");

    expect(report.summary.designScore).toBeGreaterThan(50);
    expect(["passed", "failed"]).toContain(reportStatus(report));
  });
});
