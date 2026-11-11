import type { Locator, Page } from "playwright";
import type { Step, Target } from "@figtest/contracts";
import type { LogFn, UrlPolicy } from "./index";
import { trackNetwork, type NetworkTracker } from "./network";
import { checkUrl } from "./policy";
import { firstLine, normalizeHost } from "./site";

const STEP_TIMEOUT = 10_000;
const GOTO_TIMEOUT = 30_000;
/** after a click, a key or a navigation: the page may submit, navigate or call its API */
const AFTER_ACTION_QUIET = 5_000;

type AriaRole = Parameters<Page["getByRole"]>[0];

/** Runs the steps in order (each with a timeout); throws with the step number and what failed. No code is evaluated. */
export async function runSteps(page: Page, steps: Step[], opts: { baseUrl: string; policy: UrlPolicy; log: LogFn; timeout?: number }): Promise<void> {
  if (!steps.length) return;
  const timeout = opts.timeout ?? STEP_TIMEOUT;
  const base = new URL(opts.baseUrl);
  const network = trackNetwork(page);
  try {
    for (const [i, step] of steps.entries()) {
      const label = `step ${i + 1} (${describeStep(step)})`;
      await opts.log(label, "debug");
      try {
        await runStep(page, step, { base, policy: opts.policy, timeout, network });
      } catch (e) {
        throw new Error(`${label}: ${await reasonOf(page, step, e, timeout)}`, { cause: e });
      }
    }
  } finally {
    network.dispose();
  }
}

async function runStep(page: Page, step: Step, ctx: { base: URL; policy: UrlPolicy; timeout: number; network: NetworkTracker }) {
  const { timeout } = ctx;
  switch (step.action) {
    case "goto": {
      let url: URL;
      try {
        url = new URL(step.url, ctx.base);
      } catch {
        throw new StepError(`not a URL: ${step.url}`);
      }
      if (normalizeHost(url.host) !== normalizeHost(ctx.base.host)) {
        throw new StepError(`goto refused: ${url.host} is not the host of the screen (${ctx.base.host})`);
      }
      await checkUrl(url.href, ctx.policy);
      await page.goto(url.href, { waitUntil: "load", timeout: Math.max(timeout, GOTO_TIMEOUT) });
      await ctx.network.quiet(AFTER_ACTION_QUIET);
      return;
    }
    case "click":
      await locate(page, step.target).click({ timeout });
      await ctx.network.quiet(AFTER_ACTION_QUIET);
      return;
    case "fill":
      await locate(page, step.target).fill(step.value, { timeout });
      return;
    case "select":
      // a value or the label of an option
      await locate(page, step.target).selectOption(step.value, { timeout });
      await ctx.network.quiet(AFTER_ACTION_QUIET);
      return;
    case "check":
      await locate(page, step.target).setChecked(step.checked ?? true, { timeout });
      await ctx.network.quiet(AFTER_ACTION_QUIET);
      return;
    case "press":
      if (step.target) await locate(page, step.target).press(step.key, { timeout });
      else await page.keyboard.press(step.key);
      await ctx.network.quiet(AFTER_ACTION_QUIET);
      return;
    case "hover":
      await locate(page, step.target).hover({ timeout });
      return;
    case "scroll":
      if (step.target) await locate(page, step.target).scrollIntoViewIfNeeded({ timeout });
      else await page.evaluate(`window.scrollTo(0, ${Number(step.y ?? 0)})`);
      return;
    case "waitFor":
      await locate(page, step.target).waitFor({ state: step.state ?? "visible", timeout });
      return;
    case "wait":
      await page.waitForTimeout(Math.min(Math.max(0, step.ms), 30_000));
      return;
    default: {
      const unknown: never = step;
      throw new StepError(`unknown action ${JSON.stringify((unknown as { action?: unknown }).action)}`);
    }
  }
}

/** Target -> locator: the first set field of testId, role (+ name), label, placeholder, text, css; nth picks one. */
export function locate(page: Page, t: Target): Locator {
  const exact = t.exact;
  let loc: Locator;
  if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.role) loc = page.getByRole(t.role as AriaRole, t.name !== undefined ? { name: t.name, exact } : {});
  else if (t.label) loc = page.getByLabel(t.label, { exact });
  else if (t.placeholder) loc = page.getByPlaceholder(t.placeholder, { exact });
  else if (t.text) loc = page.getByText(t.text, { exact });
  else if (t.css) loc = page.locator(t.css);
  else throw new StepError("the target has no testId, role, label, placeholder, text or css");
  return t.nth !== undefined ? loc.nth(t.nth) : loc.first();
}

/** "click role=button name=Next", "fill label=Email value=\"a@b.c\"", "goto /cart" */
export function describeStep(step: Step): string {
  switch (step.action) {
    case "goto":
      return `goto ${step.url}`;
    case "fill":
    case "select":
      return `${step.action} ${describeTarget(step.target)} value=${quote(step.value)}`;
    case "check":
      return `${step.checked === false ? "uncheck" : "check"} ${describeTarget(step.target)}`;
    case "press":
      return `press ${step.key}${step.target ? ` on ${describeTarget(step.target)}` : ""}`;
    case "scroll":
      return step.target ? `scroll to ${describeTarget(step.target)}` : `scroll y=${step.y ?? 0}`;
    case "waitFor":
      return `waitFor ${describeTarget(step.target)}${step.state === "hidden" ? " hidden" : ""}`;
    case "wait":
      return `wait ${step.ms} ms`;
    default:
      return `${step.action} ${describeTarget(step.target)}`;
  }
}

export function describeTarget(t: Target): string {
  const parts: string[] = [];
  if (t.testId) parts.push(`testId=${quote(t.testId)}`);
  else if (t.role) {
    parts.push(`role=${quote(t.role)}`);
    if (t.name !== undefined) parts.push(`name=${quote(t.name)}`);
  } else if (t.label) parts.push(`label=${quote(t.label)}`);
  else if (t.placeholder) parts.push(`placeholder=${quote(t.placeholder)}`);
  else if (t.text) parts.push(`text=${quote(t.text)}`);
  else if (t.css) parts.push(`css=${quote(t.css)}`);
  if (t.exact) parts.push("exact");
  if (t.nth !== undefined) parts.push(`nth=${t.nth}`);
  return parts.join(" ");
}

function quote(v: string) {
  const s = v.length > 60 ? `${v.slice(0, 57)}...` : v;
  return /^[\p{L}\p{N}_./#:-]+$/u.test(s) ? s : JSON.stringify(s);
}

class StepError extends Error {}

/** what failed, for a human or the AI: no element, an element that never became usable, a missing option ... */
async function reasonOf(page: Page, step: Step, e: unknown, timeout: number): Promise<string> {
  if (e instanceof StepError) return e.message;
  const message = firstLine(e).replace(/^[a-zA-Z]+\.[a-zA-Z]+: /, "");
  const timedOut = e instanceof Error && (e.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(e.message));
  const target = "target" in step ? step.target : undefined;
  if (!timedOut || !target || page.isClosed()) return message;
  const secs = Math.round(timeout / 1000);
  let count = -1;
  try {
    count = await locate(page, target).count();
  } catch {
    /* a bad css selector: the message says it */
  }
  if (count === 0) return `no element matches ${describeTarget(target)} (waited ${secs} s)`;
  if (step.action === "select") {
    const options = await locate(page, target).locator("option").allTextContents().catch(() => [] as string[]);
    if (options.length) return `no option ${JSON.stringify(step.value)} (options: ${options.map((o) => JSON.stringify(o.trim())).slice(0, 15).join(", ")})`;
  }
  if (step.action === "waitFor") return `the element did not become ${step.state ?? "visible"} within ${secs} s`;
  return `the element is there but did not become visible, enabled and still within ${secs} s (${message})`;
}
