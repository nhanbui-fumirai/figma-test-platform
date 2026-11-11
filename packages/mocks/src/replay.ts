import type { BrowserContext, Route } from "playwright";
import { graphqlOf, isApiRequest } from "./api";
import { canonical, deepEqual, isRecord } from "./json";
import type { ReplayOptions, ServedRoute } from "./types";

/**
 * The route for a request, or null. GraphQL: same operationName, the closest variables win (exact first). REST: same
 * method + host + path, exact query first, else the closest query (most equal params, fewest extra).
 */
export function matchRoute(req: { method: string; url: string; postData: string | null }, routes: ServedRoute[]): ServedRoute | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  const method = req.method.toUpperCase();
  const path = trimSlash(url.pathname);
  const host = url.host.toLowerCase();
  const same = routes.filter((r) => r.method.toUpperCase() === method && (!r.host || r.host.toLowerCase() === host) && trimSlash(r.path) === path);
  if (!same.length) return null;

  const gql = graphqlOf(method, url, req.postData);
  if (gql) {
    // GraphQL: every call is POST /graphql; another operation never answers
    const ops = same.filter((r) => r.operationName === gql.operationName);
    if (!ops.length) return null;
    const wanted = normalizeVariables(gql.variables);
    return ops.find((r) => deepEqual(normalizeVariables(r.variables), wanted)) ?? best(ops, (r) => likeness(normalizeVariables(r.variables), wanted));
  }

  const rest = same.filter((r) => !r.operationName);
  if (!rest.length) return null;
  const query = Object.fromEntries(url.searchParams.entries());
  const exact = rest.find((r) => deepEqual(r.query ?? {}, query));
  if (exact) return exact;
  // the closest query: most params with the same value, then fewest params that differ (missing, extra or other value)
  return best(rest, (r) => {
    const q = r.query ?? {};
    const keys = new Set([...Object.keys(q), ...Object.keys(query)]);
    let equal = 0;
    let differing = 0;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(q, k) && Object.prototype.hasOwnProperty.call(query, k) && q[k] === query[k]) equal++;
      else differing++;
    }
    return equal * 10_000 - differing;
  });
}

/** the highest score, the first one on a tie */
function best<T>(items: T[], score: (x: T) => number): T | null {
  let out: T | null = null;
  let top = -Infinity;
  for (const x of items) {
    const s = score(x);
    if (s > top) {
      top = s;
      out = x;
    }
  }
  return out;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const normalizeVariables = (v: unknown) => (v === null || v === undefined ? {} : v);

/** the leaves of a JSON value, "input.cartId" -> its value as canonical JSON */
function leaves(v: unknown, at: string, out: Map<string, string>) {
  if (Array.isArray(v) && v.length) v.forEach((x, i) => leaves(x, `${at}[${i}]`, out));
  else if (isRecord(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) leaves(x, at ? `${at}.${k}` : k, out);
  else out.set(at, canonical(v));
  return out;
}

/**
 * How close two sets of variables are when none is equal (a date the page computes when it runs): 10 per leaf both
 * have with the same value, 1 per leaf both have with another value. The call recorded with the most alike variables
 * answers (one operation called first without a cart id, then with it, gets the answer of the call it looks like).
 */
export function likeness(a: unknown, b: unknown): number {
  const x = leaves(a, "", new Map());
  const y = leaves(b, "", new Map());
  let n = 0;
  for (const [k, v] of x) if (y.has(k)) n += y.get(k) === v ? 10 : 1;
  return n;
}

/** "POST /graphql op=GetCart", "GET /api/products?limit=8" */
export function describeRequest(method: string, url: string, postData: string | null): string {
  try {
    const u = new URL(url);
    const gql = graphqlOf(method, u, postData);
    return `${method.toUpperCase()} ${u.pathname}${gql ? ` op=${gql.operationName}` : u.search}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

/** Serves the routes to every page of the context; API requests without a route go to the network and are reported. */
export async function installMocks(context: BrowserContext, routes: ServedRoute[], opts: ReplayOptions): Promise<void> {
  const reported = new Set<string>();
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    if (!isApiRequest(request.url(), request.resourceType(), opts)) return route.fallback();
    const method = request.method();
    const postData = request.postData();
    const hit = matchRoute({ method, url: request.url(), postData }, routes);
    if (!hit) {
      const description = describeRequest(method, request.url(), postData);
      if (!reported.has(description)) {
        reported.add(description);
        try {
          opts.onUnmatched(description);
        } catch {
          /* the reporter must not break the page */
        }
      }
      return route.continue().catch(() => undefined);
    }
    // a page on another origin than its API gets the CORS headers the API would send
    const origin = (await request.headerValue("origin").catch(() => null)) ?? null;
    const headers: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" }
      : { "access-control-allow-origin": "*" };
    const noBody = hit.status === 204 || hit.status === 304 || method.toUpperCase() === "HEAD";
    return route
      .fulfill({
        status: hit.status,
        headers,
        contentType: hit.contentType || "application/json",
        body: noBody ? "" : typeof hit.body === "string" ? hit.body : (JSON.stringify(hit.body) ?? ""),
      })
      .catch(() => undefined);
  });
}
