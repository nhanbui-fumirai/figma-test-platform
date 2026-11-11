import type { Page } from "playwright";
import type { UrlPolicy } from "./index";
import { evaluateWithin, trackNetwork } from "./network";
import { BlockedUrlError, checkUrl } from "./policy";
import { normalizeHost } from "./site";

/** Chromium takes screenshots up to 16384 px high; the design of a frame is capped the same way */
export const MAX_SCREENSHOT_HEIGHT = 16_000;
const GOTO_TIMEOUT = 45_000;
const SETTLE_CAP = 20_000;

/** status of the last document openPage() loaded in a page (detectAuthWall reads it) */
export const documentStatus = new WeakMap<Page, { url: string; status: number | null }>();

/** checkUrl, goto, settle. Returns the final URL and the HTTP status of the document. */
export async function openPage(page: Page, url: string, policy: UrlPolicy): Promise<{ finalUrl: string; status: number | null }> {
  const requested = await checkUrl(url, policy);
  // DOM ready within 45 s, then the load event (images, scripts) for a while more: a page whose load never ends (a
  // tracker that hangs) is still measured
  const response = await page.goto(requested.href, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT });
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);

  // a redirect is followed by the browser itself: the final host passes the policy too
  const finalUrl = page.url();
  let finalHost = "";
  try {
    finalHost = new URL(finalUrl).hostname;
  } catch {
    /* about:blank, data: */
  }
  if (finalHost && normalizeHost(finalHost) !== normalizeHost(requested.hostname)) {
    try {
      await checkUrl(finalUrl, policy);
    } catch (e) {
      await page.goto("about:blank").catch(() => undefined);
      if (e instanceof BlockedUrlError) throw new BlockedUrlError(`${requested.host} redirected to a refused URL: ${e.message}`);
      throw e;
    }
  }

  const status = response?.status() ?? null;
  documentStatus.set(page, { url: finalUrl, status });
  await settle(page);
  return { finalUrl: page.url(), status };
}

/** no animation, transition or caret blink; no scrollbar (headed Chromium) */
const FREEZE_CSS = [
  "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;",
  "transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }",
  "html { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }",
].join("\n");

// In-page scripts are strings: no DOM types in this Node package, nothing injected by a bundler.
const FONTS_JS = `(async () => { if (document.fonts) await document.fonts.ready; return true; })()`;

/** scroll down in steps (lazy images, infinite sections, IntersectionObserver), then back to the top */
const SCROLL_JS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 100); });
  const root = document.scrollingElement || document.documentElement;
  const step = Math.max(200, Math.floor(innerHeight * 0.8));
  const deadline = Date.now() + 7000;
  let y = 0;
  while (y < Math.min(root.scrollHeight, ${MAX_SCREENSHOT_HEIGHT}) && Date.now() < deadline) {
    y += step;
    window.scrollTo(0, y);
    await frame();
    await sleep(60);
  }
  window.scrollTo(0, 0);
  await frame();
  return y;
})()`;

/** the images that are rendered and not loaded yet: wait for each to load or fail, then decode them */
const IMAGES_JS = `(async () => {
  const shown = [...document.images].filter((i) => i.getClientRects().length > 0);
  await Promise.all(shown.filter((i) => !i.complete).map((i) => new Promise((r) => {
    i.addEventListener("load", r, { once: true });
    i.addEventListener("error", r, { once: true });
  })));
  await Promise.all(shown.filter((i) => i.complete && i.naturalWidth > 0).map((i) => i.decode().catch(() => null)));
  return shown.length;
})()`;

const FRAMES_JS = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;

/** Waits for the page to be still: network idle (capped), fonts loaded, animations and transitions off, lazy images loaded. */
export async function settle(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const started = Date.now();
  const left = (cap: number) => Math.max(0, Math.min(cap, SETTLE_CAP - (Date.now() - started)));
  const network = trackNetwork(page);
  try {
    await page.waitForLoadState("networkidle", { timeout: left(5_000) || 1 }).catch(() => undefined);
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
    await evaluateWithin(page, FONTS_JS, left(5_000));
    await evaluateWithin(page, SCROLL_JS, left(8_000));
    await evaluateWithin(page, IMAGES_JS, left(5_000));
    // what the scroll loaded (images, sections fetched on view)
    await network.quiet(left(3_000));
    await evaluateWithin(page, FONTS_JS, left(2_000));
    await evaluateWithin(page, FRAMES_JS, left(1_000));
  } finally {
    network.dispose();
  }
}

/** PNG of the whole page (capped at 16000 px high). */
export async function fullPageScreenshot(page: Page): Promise<Buffer> {
  const size = await page.evaluate(`(() => {
    const d = document.documentElement, b = document.body;
    return { w: Math.max(d.scrollWidth, b ? b.scrollWidth : 0, innerWidth), h: Math.max(d.scrollHeight, b ? b.scrollHeight : 0, innerHeight) };
  })()`) as { w: number; h: number };
  const options = { type: "png" as const, fullPage: true, animations: "disabled" as const, caret: "hide" as const, scale: "css" as const, timeout: 60_000 };
  if (size.h > MAX_SCREENSHOT_HEIGHT) {
    return page.screenshot({ ...options, clip: { x: 0, y: 0, width: Math.ceil(size.w), height: MAX_SCREENSHOT_HEIGHT } });
  }
  return page.screenshot(options);
}

/** Accessibility tree of the page as text (for the AI steps loop), capped in size. */
export async function ariaSnapshot(page: Page, maxChars = 20000): Promise<string> {
  const text = await page.locator("body").ariaSnapshot({ timeout: 10_000 });
  if (text.length <= maxChars) return text;
  const marker = `\n... [truncated, ${text.length} chars]`;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}
