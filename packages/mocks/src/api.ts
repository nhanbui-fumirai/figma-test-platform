/**
 * Which requests are API calls (recorded, then served from the mocks), and what a GraphQL request asks for.
 *
 * API call: with include globs (project apiInclude), a request whose full URL (or the URL without its query) matches
 * one of them and that loads data, not a page, script, style, image, font or media; without globs, a fetch / XHR
 * request to the site host.
 * Globs: `**` = any characters, `*` = any characters but "/", `?` = one character; the rest is literal.
 */

/** resource types that are never API data, even when a glob matches their URL (maps.googleapis.com/maps/api/js) */
const NOT_DATA = new Set(["document", "stylesheet", "image", "media", "font", "script", "texttrack", "manifest", "websocket", "beacon", "ping"]);

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      // "**/" also matches nothing: "**/api/**" matches "https://host/api/x"
      if (glob[i + 1] === "/") {
        re += "/?";
        i++;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  const out = new RegExp(`^${re}$`);
  globCache.set(glob, out);
  return out;
}

export function globMatch(glob: string, url: string): boolean {
  const re = globToRegExp(glob.trim());
  if (re.test(url)) return true;
  const bare = url.replace(/[?#].*$/, "");
  return bare !== url && re.test(bare);
}

/** "shop.example.com", "127.0.0.1:5173" or a URL given by mistake -> the host to compare with */
function hostOf(siteHost: string): string {
  const s = siteHost.trim().toLowerCase();
  if (s.includes("://")) {
    try {
      return new URL(s).host;
    } catch {
      return s;
    }
  }
  return s.replace(/\/.*$/, "");
}

export function isApiRequest(url: string, resourceType: string, opts: { include: string[]; siteHost: string }): boolean {
  const include = opts.include.map((g) => g.trim()).filter(Boolean);
  if (include.length) return !NOT_DATA.has(resourceType) && include.some((g) => globMatch(g, url));
  if (resourceType !== "fetch" && resourceType !== "xhr") return false;
  try {
    const u = new URL(url);
    const site = hostOf(opts.siteHost);
    return u.host.toLowerCase() === site || u.hostname.toLowerCase() === site;
  } catch {
    return false;
  }
}

/** operationName (+ variables) of a GraphQL request, from a POST JSON body or the GET params; null when it is not one */
export function graphqlOf(method: string, url: URL, postData: string | null): { operationName: string; variables: unknown } | null {
  if (method.toUpperCase() === "GET") {
    const params = url.searchParams;
    const query = params.get("query");
    const named = params.get("operationName");
    if (!named && !(query && looksLikeGraphql(query))) return null;
    const name = named || nameInQuery(query);
    if (!name) return null;
    return { operationName: name, variables: parseJson(params.get("variables")) ?? null };
  }
  if (!postData) return null;
  const body = parseJson(postData);
  if (Array.isArray(body)) {
    // a batch: one call for the operations together
    const ops = body.map(operationOf);
    if (!ops.length || ops.some((o) => !o)) return null;
    return { operationName: ops.map((o) => o?.operationName).join("+"), variables: ops.map((o) => o?.variables ?? null) };
  }
  return operationOf(body);
}

function operationOf(body: unknown): { operationName: string; variables: unknown } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as { operationName?: unknown; query?: unknown; variables?: unknown; extensions?: unknown };
  const named = typeof b.operationName === "string" && b.operationName ? b.operationName : null;
  const query = typeof b.query === "string" ? b.query : null;
  const persisted = !!b.extensions && typeof b.extensions === "object" && "persistedQuery" in (b.extensions as object);
  if (!named && !(query && looksLikeGraphql(query)) && !persisted) return null;
  const name = named ?? nameInQuery(query);
  if (!name) return null;
  return { operationName: name, variables: b.variables ?? null };
}

const looksLikeGraphql = (q: string) => /^\s*(#[^\n]*\n\s*)*(query|mutation|subscription|fragment|\{)/.test(q);
const nameInQuery = (q: string | null) => (q ? /\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(q)?.[1] ?? null : null);

export function parseJson(text: string | null | undefined): unknown {
  if (text == null || text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
