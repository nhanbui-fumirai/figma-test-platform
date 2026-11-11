import { chromium, type Browser, type BrowserContext } from "playwright";
import type { ContextOptions } from "./index";
import { BlockedUrlError, checkUrl } from "./policy";

/** Safari on an iPhone: what a phone-only site expects to see */
export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Chromium, headless by default (HEADLESS=false shows it). */
export async function launchBrowser(opts: { headless?: boolean } = {}): Promise<Browser> {
  const env = (process.env.HEADLESS ?? "").trim().toLowerCase();
  const headless = opts.headless ?? !(env === "false" || env === "0" || env === "no");
  return chromium.launch({ headless, args: ["--disable-dev-shm-usage"] });
}

/** A context for one screen: viewport, phone emulation, cookies, storage state; document navigations checked by the policy. */
export async function newContext(browser: Browser, opts: ContextOptions): Promise<BrowserContext> {
  const width = Math.max(1, Math.round(opts.viewport.w));
  const height = Math.max(1, Math.round(opts.viewport.h));
  const mobile = opts.mobile ?? width < 768;
  const cookieUrl = new URL(opts.cookieUrl);

  const context = await browser.newContext({
    viewport: { width, height },
    // 1 CSS px = 1 screenshot px: the boxes of the DOM and of the screenshot are the same numbers
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    ...(mobile ? { userAgent: MOBILE_USER_AGENT } : {}),
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
    // the style tag of settle() must work on pages with a strict Content-Security-Policy
    bypassCSP: true,
    // a service worker would answer requests before the routes (mocks, URL policy) see them
    serviceWorkers: "block",
  });

  try {
    if (opts.cookies?.length) {
      await context.addCookies(
        opts.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || cookieUrl.hostname,
          path: c.path || "/",
          secure: cookieUrl.protocol === "https:",
          sameSite: "Lax" as const,
        })),
      );
    }

    // every document (page or frame) the browser navigates to goes through the URL policy; a refused one is aborted
    const allowed = new Map<string, number>(); // hostname -> time it passed (a minute of cache)
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.resourceType() !== "document") return route.fallback();
      const url = request.url();
      let hostname = "";
      try {
        hostname = new URL(url).hostname;
      } catch {
        return route.abort("blockedbyclient");
      }
      const passed = allowed.get(hostname);
      if (passed !== undefined && Date.now() - passed < 60_000 && /^https?:/i.test(url)) return route.fallback();
      try {
        await checkUrl(url, opts.policy);
        allowed.set(hostname, Date.now());
        return await route.fallback();
      } catch (e) {
        if (e instanceof BlockedUrlError) return route.abort("blockedbyclient").catch(() => undefined);
        return route.fallback().catch(() => undefined); // not resolvable: the browser fails on its own
      }
    });
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
  return context;
}
