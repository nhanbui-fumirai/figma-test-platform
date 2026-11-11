import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { applyOps, installMocks, matchRoute, startRecording, type RecordedCall, type ServedRoute } from "./index";
import { globMatch, isApiRequest } from "./api";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const route = (r: Partial<ServedRoute> & { id: string }): ServedRoute => ({
  method: "GET",
  host: "shop.test",
  path: "/api/items",
  query: {},
  operationName: null,
  variables: null,
  status: 200,
  contentType: "application/json",
  body: { from: r.id },
  ...r,
});
const gqlPost = (operationName: string, variables: unknown) => ({ method: "POST", url: "https://shop.test/graphql", postData: JSON.stringify({ operationName, query: `query ${operationName} { x }`, variables }) });

describe("matchRoute", () => {
  const gql = [
    route({ id: "cart-empty", method: "POST", path: "/graphql", operationName: "GetCart", variables: { input: { cartId: null, date: "2026-01-01" } } }),
    route({ id: "cart-full", method: "POST", path: "/graphql", operationName: "GetCart", variables: { input: { cartId: "c1", date: "2026-01-01" } } }),
    route({ id: "cart-other", method: "POST", path: "/graphql", operationName: "GetCart", variables: { input: { cartId: "c2", date: "2026-01-01" } } }),
    route({ id: "user", method: "POST", path: "/graphql", operationName: "GetUser", variables: {} }),
  ];

  it("GraphQL: same operation, exact variables first", () => {
    expect(matchRoute(gqlPost("GetCart", { input: { cartId: "c2", date: "2026-01-01" } }), gql)?.id).toBe("cart-other");
    expect(matchRoute(gqlPost("GetUser", undefined), gql)?.id).toBe("user");
  });

  it("GraphQL: else the closest variables (a date computed when the page runs), first on a tie", () => {
    expect(matchRoute(gqlPost("GetCart", { input: { cartId: "c1", date: "2026-11-10" } }), gql)?.id).toBe("cart-full");
    expect(matchRoute(gqlPost("GetCart", { input: { cartId: "c9", date: "2026-11-10" } }), gql)?.id).toBe("cart-empty");
    expect(matchRoute(gqlPost("GetCart", { other: 1 }), gql)?.id).toBe("cart-empty");
  });

  it("GraphQL: another operation never answers", () => {
    expect(matchRoute(gqlPost("GetOrders", {}), gql)).toBeNull();
  });

  it("GraphQL over GET", () => {
    const routes = [route({ id: "g", path: "/graphql", operationName: "Search", variables: { q: "sofa" } })];
    const url = `https://shop.test/graphql?query=${encodeURIComponent("query Search($q: String) { s(q: $q) }")}&variables=${encodeURIComponent('{"q":"chair"}')}`;
    expect(matchRoute({ method: "GET", url, postData: null }, routes)?.id).toBe("g");
  });

  const rest = [
    route({ id: "all", query: {} }),
    route({ id: "page1", query: { page: "1", limit: "8" } }),
    route({ id: "page2", query: { page: "2", limit: "8" } }),
    route({ id: "post", method: "POST", query: {} }),
    route({ id: "other-host", host: "api.other.test", query: { page: "1", limit: "8" } }),
  ];

  it("REST: method + host + path, the exact query first", () => {
    expect(matchRoute({ method: "GET", url: "https://shop.test/api/items?limit=8&page=2", postData: null }, rest)?.id).toBe("page2");
    expect(matchRoute({ method: "GET", url: "https://shop.test/api/items", postData: null }, rest)?.id).toBe("all");
    expect(matchRoute({ method: "POST", url: "https://shop.test/api/items?page=1", postData: '{"x":1}' }, rest)?.id).toBe("post");
    expect(matchRoute({ method: "GET", url: "https://api.other.test/api/items?page=1&limit=8", postData: null }, rest)?.id).toBe("other-host");
  });

  it("REST: else the closest query (most equal params, fewest differing)", () => {
    expect(matchRoute({ method: "GET", url: "https://shop.test/api/items?page=2&limit=20", postData: null }, rest)?.id).toBe("page2");
    expect(matchRoute({ method: "GET", url: "https://shop.test/api/items?sort=new", postData: null }, rest)?.id).toBe("all");
    expect(matchRoute({ method: "GET", url: "https://shop.test/api/items?page=1&limit=8&utm=x", postData: null }, rest)?.id).toBe("page1");
  });

  it("REST: nothing for another path, method or host", () => {
    expect(matchRoute({ method: "GET", url: "https://shop.test/api/other", postData: null }, rest)).toBeNull();
    expect(matchRoute({ method: "DELETE", url: "https://shop.test/api/items", postData: null }, rest)).toBeNull();
    expect(matchRoute({ method: "GET", url: "https://nope.test/api/items", postData: null }, rest)).toBeNull();
  });
});

describe("API requests", () => {
  it("matches globs on the full URL", () => {
    expect(globMatch("**/api/**", "https://shop.test/api/items?x=1")).toBe(true);
    expect(globMatch("**/graphql", "https://shop.test/bff/graphql?op=1")).toBe(true);
    expect(globMatch("https://shop.test/*/items", "https://shop.test/api/items")).toBe(true);
    expect(globMatch("https://shop.test/*/items", "https://shop.test/a/b/items")).toBe(false);
    expect(globMatch("**/v?/items", "https://shop.test/v2/items")).toBe(true);
    expect(globMatch("**/api/**", "https://shop.test/apix/items")).toBe(false);
  });

  it("is a fetch / XHR to the site host without globs, data of a matching URL with them", () => {
    const site = { include: [], siteHost: "shop.test" };
    expect(isApiRequest("https://shop.test/api/x", "fetch", site)).toBe(true);
    expect(isApiRequest("https://shop.test/api/x", "script", site)).toBe(false);
    expect(isApiRequest("https://cdn.test/api/x", "xhr", site)).toBe(false);
    const globs = { include: ["**/api/**"], siteHost: "shop.test" };
    expect(isApiRequest("https://cdn.test/api/x", "xhr", globs)).toBe(true);
    expect(isApiRequest("https://maps.test/maps/api/js", "script", globs)).toBe(false);
  });
});

// ---------------------------------------------------------------- record, then replay with the server stopped

const SHOP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
<ul id="products"></ul><p id="cart"></p><img src="/logo.png" alt="">
<script>
(async () => {
  const products = await fetch("/api/products?limit=2").then((r) => r.json());
  await fetch("/api/products?limit=2").then((r) => r.json()); // the same request twice (StrictMode)
  document.getElementById("products").innerHTML = products.items.map((p) => "<li>" + p.name + "</li>").join("");
  const cart = await fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
    body: JSON.stringify({ operationName: "GetCart", query: "query GetCart($id: ID!) { cart(id: $id) { total } }", variables: { id: "c1" } }),
  }).then((r) => r.json());
  document.getElementById("cart").textContent = "Total " + cart.data.cart.total;
  await fetch("/api/old").catch(() => null);
  await fetch("/api/big").catch(() => null);
  for (let i = 0; i < 2; i++) await fetch("/api/extra?x=1").catch(() => null);
  document.body.dataset.done = "1";
})();
</script></body></html>`;

let server: http.Server;
let base = "";
let siteHost = "";
let browser: Browser;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "set-cookie": "sid=abc; Path=/", "x-secret": "do-not-keep" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/shop") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(SHOP_HTML);
    }
    if (url.pathname === "/api/products") return json({ items: [{ id: 1, name: "Cloud sofa" }, { id: 2, name: "Oak chair" }].slice(0, Number(url.searchParams.get("limit") ?? 9)) });
    if (url.pathname === "/graphql" && req.method === "POST") {
      req.resume();
      return req.on("end", () => json({ data: { cart: { total: 99 } } }));
    }
    if (url.pathname === "/api/old") {
      res.writeHead(302, { location: "/api/products?limit=2" });
      return res.end();
    }
    if (url.pathname === "/api/big") return json({ blob: "x".repeat(6 * 1024 * 1024) });
    if (url.pathname === "/api/extra") return json({ extra: true });
    if (url.pathname === "/logo.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  siteHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${siteHost}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("record and replay", () => {
  let calls: RecordedCall[] = [];

  it("records one call per distinct API request, bodies only", async () => {
    const context = await browser.newContext();
    try {
      const recorder = await startRecording(context, { include: [], siteHost });
      const page = await context.newPage();
      await page.goto(`${base}/shop`);
      await page.waitForSelector("body[data-done]");
      calls = await recorder.stop();
    } finally {
      await context.close();
    }
    const byKey = (path: string) => calls.filter((c) => c.path === path);
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(["GET /api/extra", "GET /api/products", "POST /graphql"]);
    expect(byKey("/api/products")).toHaveLength(1);
    const products = byKey("/api/products")[0]!;
    expect(products).toEqual({
      method: "GET",
      url: `${base}/api/products?limit=2`,
      host: siteHost,
      path: "/api/products",
      query: { limit: "2" },
      operationName: null,
      variables: null,
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: { items: [{ id: 1, name: "Cloud sofa" }, { id: 2, name: "Oak chair" }] },
    });
    const cart = byKey("/graphql")[0]!;
    expect(cart.operationName).toBe("GetCart");
    expect(cart.variables).toEqual({ id: "c1" });
    expect(cart.body).toEqual({ data: { cart: { total: 99 } } });
    // never a header, a cookie or the token the page sent
    expect(JSON.stringify(calls)).not.toMatch(/secret-token|do-not-keep|sid=abc/);
  });

  it("records the URLs of the include globs only", async () => {
    const context = await browser.newContext();
    try {
      const recorder = await startRecording(context, { include: ["**/graphql"], siteHost: "elsewhere.test" });
      const page = await context.newPage();
      await page.goto(`${base}/shop`);
      await page.waitForSelector("body[data-done]");
      expect((await recorder.stop()).map((c) => c.path)).toEqual(["/graphql"]);
    } finally {
      await context.close();
    }
  });

  it("replays the routes with the server stopped; an unmatched call is reported once", async () => {
    expect(calls.length).toBeGreaterThan(0);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));

    const routes: ServedRoute[] = calls
      .filter((c) => c.path !== "/api/extra")
      .map((c, i) => ({ id: String(i), method: c.method, host: c.host, path: c.path, query: c.query, operationName: c.operationName, variables: c.variables, status: c.status, contentType: c.contentType, body: c.body }));
    const products = routes.find((r) => r.path === "/api/products")!;
    products.body = applyOps(products.body, [{ op: "set", path: "/items/0/name", value: "Edited sofa" }]);

    const unmatched: string[] = [];
    const context = await browser.newContext();
    try {
      // the page itself (its server is gone), registered first: the mocks pass documents on
      await context.route(`${base}/shop`, (r) => r.fulfill({ contentType: "text/html", body: SHOP_HTML }));
      await installMocks(context, routes, { include: [], siteHost, onUnmatched: (d) => unmatched.push(d) });
      const page = await context.newPage();
      await page.goto(`${base}/shop`);
      await page.waitForSelector("body[data-done]");
      expect(await page.locator("#products li").allTextContents()).toEqual(["Edited sofa", "Oak chair"]);
      expect(await page.locator("#cart").textContent()).toBe("Total 99");
      // not recorded (a redirect, a body over 5 MB, a call left out): each reported once, though /api/extra is called twice
      expect(unmatched).toEqual(["GET /api/old", "GET /api/big", "GET /api/extra?x=1"]);
    } finally {
      await context.close();
    }
  });
});
