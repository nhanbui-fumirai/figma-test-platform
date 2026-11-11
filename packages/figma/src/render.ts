/**
 * The image of a frame: its HTML (html.ts) drawn by headless Chromium, frame width × design height (area.ts: the same
 * design area as the spec). One page is reused for every frame; the image fills come from the document (doc.image),
 * the fonts from Google Fonts: their CSS and their files are kept for the next frames. A family Google does not have
 * is drawn with the font that looks like it (html.ts fontAlias) or an installed one, and named in the warnings.
 * Approximate (effects, text metrics differ a little from Figma's): good for a reference image and a visual diff, not
 * for pixel equality.
 */
import { type Browser, type BrowserContext, type Page, type Route, chromium } from "playwright";
import sharp from "sharp";
import { type FontUse, fontAlias, framePage, frameHtml } from "./html";
import type { DesignDocument, DesignFrame, RenderResult } from "./types";

const BASE = "http://fig.local/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"; // woff2 rules

function mime(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (/^\s*<(\?xml|svg)/i.test(b.subarray(0, 100).toString("latin1"))) return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * Run in the page (plain JS: the package is built without the DOM types): waits for the images and the fonts, then
 * says of each family whether it is loaded, failed, not needed by the text ("unused"), installed ("local") or missing.
 */
const SETTLE = `async ({ urls, families }) => {
  void document.body.offsetHeight;
  await Promise.all(urls.map((src) => new Promise((done) => {
    const img = new Image();
    img.onload = img.onerror = () => done(null);
    img.src = src;
  })));
  await document.fonts.ready;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const out = {};
  const ctx = document.createElement("canvas").getContext("2d");
  const measure = (font) => { ctx.font = font; return ctx.measureText("mmmmmmmmmmlli WQ 1234 \\u3042\\u3044\\u3046\\u6f22\\u5b57").width; };
  for (const family of families) {
    const faces = [...document.fonts].filter((f) => f.family.replace(/^["']|["']$/g, "") === family);
    if (faces.length) {
      out[family] = faces.some((f) => f.status === "loaded") ? "loaded" : faces.some((f) => f.status === "error") ? "error" : "unused";
      continue;
    }
    const quoted = "'" + family.replace(/'/g, "\\\\'") + "'";
    const local = ["monospace", "serif"].some((g) => measure("16px " + quoted + ", " + g) !== measure("16px " + g));
    out[family] = local ? "local" : "missing";
  }
  return out;
}`;

/** Draws frames with headless Chromium (one page reused, fonts cached). */
export class FrameRenderer {
  private browser: Browser | null = null;
  private ownBrowser = false;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** document and missing images of the frame being drawn */
  private doc: DesignDocument | null = null;
  private missingImages = new Set<string>();
  /** Google Fonts CSS by family: the "italic,weight" pairs asked, the CSS (null: Google does not have the family) */
  private fontCss = new Map<string, { pairs: Set<string>; css: string | null }>();
  private fontFiles = new Map<string, Promise<{ body: Buffer; type: string } | null>>();
  private fontsOffline = false;

  static async launch(opts: { browser?: Browser } = {}): Promise<FrameRenderer> {
    const r = new FrameRenderer();
    r.browser = opts.browser ?? null;
    await r.start();
    return r;
  }

  private start(): Promise<void> {
    this.starting ??= (async () => {
      if (!this.browser) {
        this.browser = await chromium.launch();
        this.ownBrowser = true;
      }
      this.context = await this.browser.newContext({ deviceScaleFactor: 1, viewport: { width: 800, height: 600 } });
      const page = await this.context.newPage();
      page.setDefaultTimeout(120_000);
      await page.route("**/*", (route) => this.serve(route));
      await page.goto(BASE);
      this.page = page;
    })();
    return this.starting;
  }

  /** what the page loads: the page itself, the image fills, the font files; nothing else */
  private async serve(route: Route) {
    const url = route.request().url();
    if (url === BASE) return route.fulfill({ body: "<!doctype html><html><body></body></html>", contentType: "text/html" });
    if (url.startsWith(`${BASE}img/`)) {
      const ref = decodeURIComponent(url.slice(BASE.length + 4));
      const bytes = await this.doc?.image(ref).catch(() => null);
      if (!bytes) {
        this.missingImages.add(ref);
        return route.fulfill({ status: 404, body: "" });
      }
      return route.fulfill({ body: bytes, contentType: mime(bytes), headers: { "cache-control": "no-store" } });
    }
    if (url.startsWith("https://fonts.gstatic.com/")) {
      let file = this.fontFiles.get(url);
      if (!file) {
        file = fetch(url, { signal: AbortSignal.timeout(30_000) })
          .then(async (res) => (res.ok ? { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "font/woff2" } : null))
          .catch(() => null);
        this.fontFiles.set(url, file);
      }
      const got = await file;
      if (!got) {
        this.fontFiles.delete(url);
        return route.fulfill({ status: 404, body: "" });
      }
      return route.fulfill({ body: got.body, contentType: got.type, headers: { "access-control-allow-origin": "*" } });
    }
    return route.abort();
  }

  /** @font-face rules of Google Fonts for these families (asked once, again only for new weights). */
  private async fontFaces(fonts: FontUse): Promise<string> {
    const css: string[] = [];
    for (const [family, pairs] of fonts) {
      let entry = this.fontCss.get(family);
      const missing = [...pairs].filter((p) => !entry?.pairs.has(p));
      if (!entry || (missing.length && entry.css !== null)) {
        const all = new Set([...(entry?.pairs ?? []), ...pairs]);
        entry = { pairs: all, css: await this.googleCss(family, all) };
        this.fontCss.set(family, entry);
      }
      if (entry.css) css.push(entry.css);
    }
    return css.join("\n");
  }

  private async googleCss(family: string, pairs: Set<string>): Promise<string | null> {
    if (this.fontsOffline) return null;
    const list = [...pairs].sort();
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    const weights = [...new Set(list.map((p) => p.split(",")[1]))].sort((a, b) => Number(a) - Number(b));
    const tries = [
      `family=${name}:ital,wght@${list.join(";")}`,
      `family=${name}:wght@${weights.join(";")}`,
      `family=${name}:wght@100..900`,
      `family=${name}`,
    ];
    for (const q of tries) {
      try {
        const res = await fetch(`https://fonts.googleapis.com/css2?${q}&display=block`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
        const css = await res.text();
        // a family Google does not have can still get an answer: a stand-in font (fonts.gstatic.com/l/font?kit=...)
        if (css.includes("fonts.gstatic.com/s/")) return css;
      } catch {
        this.fontsOffline = true; // no network: every family falls back
        return null;
      }
    }
    return null;
  }

  async render(doc: DesignDocument, frame: DesignFrame): Promise<RenderResult> {
    const job = this.queue.then(() => this.draw(doc, frame));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async draw(doc: DesignDocument, frame: DesignFrame): Promise<RenderResult> {
    await this.start();
    const page = this.page!;
    const built = frameHtml(frame.node);
    const width = Math.max(1, Math.round(built.width));
    const height = Math.max(1, Math.round(built.height));
    const warnings: string[] = [];
    this.doc = doc;
    this.missingImages = new Set();
    try {
      const fontCss = await this.fontFaces(built.fonts);
      await page.setViewportSize({ width, height });
      await page.setContent(framePage(built, fontCss), { waitUntil: "load" });
      const families = [...built.fonts.keys()];
      const urls = [...built.images].map((ref) => `${BASE}img/${encodeURIComponent(ref)}`);
      const status = (await page.evaluate(`(${SETTLE})(${JSON.stringify({ urls, families })})`)) as Record<string, string>;
      const fellBack = families.filter((f) => status[f] === "missing" || status[f] === "error");
      for (const f of fellBack) {
        const alias = fontAlias(f);
        warnings.push(`font "${f}" not available: drawn with ${alias && status[alias] !== "missing" ? `"${alias}"` : "a fallback font"}`);
      }
      if (this.fontsOffline && families.length) warnings.push("Google Fonts not reachable: installed fonts used");
      const png = await page.screenshot({ clip: { x: 0, y: 0, width, height }, type: "png", animations: "disabled", caret: "hide" });
      for (const ref of this.missingImages) warnings.push(`image ${ref} missing`);
      return { png, width, height, warnings };
    } finally {
      this.doc = null;
      // free the page between frames (a big frame holds its images)
      await page.setContent("<!doctype html><html><body></body></html>").catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const starting = this.starting;
    this.starting = null;
    if (!starting) return;
    await starting.catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    if (this.ownBrowser) await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    if (this.ownBrowser) this.browser = null;
  }
}

/** PNG thumbnail, `width` px wide (height kept in proportion, capped at 4 × width). */
export async function makeThumbnail(png: Buffer, width = 320): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(((meta.height ?? w) * w) / (meta.width || w)));
  // a page taller than 4 × the width: its top, cut at 4 × the width
  return sharp(png).resize({ width: w, height: Math.min(h, 4 * w), fit: "cover", position: "top" }).png().toBuffer();
}
