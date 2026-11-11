/**
 * @figtest/browser: everything a test does in the browser before comparing: launch, a context with the viewport,
 * cookies and login state of a screen, the URL policy (no private hosts unless allowed), the test login (password
 * only typed on the site host), the steps DSL, waiting for the page to settle, auth-wall detection.
 *
 * PUBLIC CONTRACT: the worker codes against the exports below. Implementations live in the other files of src/.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import type { Cookie, Step, TestLogin } from "@figtest/contracts";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface UrlPolicy {
  /** allow localhost / private / link-local addresses (dev, fixture site); off in production */
  allowPrivateHosts: boolean;
}

export interface ContextOptions {
  viewport: { w: number; h: number };
  /** phone: isMobile, touch and a mobile user agent (default: viewport.w < 768) */
  mobile?: boolean;
  /** set before the page opens; domain defaults to the host of cookieUrl */
  cookies?: Cookie[];
  cookieUrl: string;
  /** logged-in state from login() */
  storageState?: StorageState;
  policy: UrlPolicy;
}

export interface LogFn {
  (message: string, level?: "debug" | "info" | "warn" | "error"): void | Promise<void>;
}

export { launchBrowser, newContext } from "./context";
export { checkUrl, BlockedUrlError } from "./policy";
export { login } from "./login";
export { runSteps } from "./steps";
export { openPage, settle, fullPageScreenshot, ariaSnapshot } from "./page";
export { detectAuthWall } from "./auth-wall";
export type { Browser, BrowserContext, Page };
export type { Cookie, Step, TestLogin };
