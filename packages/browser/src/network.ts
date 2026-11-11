import type { Page, Request } from "playwright";

/**
 * Requests in flight on a page, to wait until it is quiet. Playwright's "networkidle" load state fires once per
 * navigation; the fetches a click or a scroll starts afterwards need their own count.
 */
export interface NetworkTracker {
  /** resolves when no request has been in flight for idleMs (at most capMs) */
  quiet(capMs: number, idleMs?: number): Promise<void>;
  dispose(): void;
}

export function trackNetwork(page: Page): NetworkTracker {
  const inflight = new Set<Request>();
  let lastActivity = Date.now();
  const start = (r: Request) => {
    // a stream that never ends would keep the page "busy" forever
    if (r.resourceType() === "websocket" || r.resourceType() === "eventsource") return;
    inflight.add(r);
    lastActivity = Date.now();
  };
  const end = (r: Request) => {
    inflight.delete(r);
    lastActivity = Date.now();
  };
  page.on("request", start);
  page.on("requestfinished", end);
  page.on("requestfailed", end);
  return {
    async quiet(capMs: number, idleMs = 400) {
      const deadline = Date.now() + Math.max(0, capMs);
      while (Date.now() < deadline && !page.isClosed()) {
        if (inflight.size === 0 && Date.now() - lastActivity >= idleMs) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    dispose() {
      page.off("request", start);
      page.off("requestfinished", end);
      page.off("requestfailed", end);
      inflight.clear();
    },
  };
}

/** page.evaluate of an expression, given up after ms (the page script may never settle); never throws. */
export async function evaluateWithin<T>(page: Page, expression: string, ms: number): Promise<T | undefined> {
  if (ms <= 0) return undefined;
  const run = page.evaluate(expression).then((v) => v as T);
  run.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), ms);
  });
  try {
    return await Promise.race([run, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
