import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext } from "playwright";
import { ariaSnapshot, BlockedUrlError, detectAuthWall, fullPageScreenshot, launchBrowser, login, newContext, openPage, runSteps } from "./index";
import { registrableDomain, sameSite } from "./site";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const dev = { allowPrivateHosts: true };
const PASSWORD = "s3cret pass!x";
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const page = (body: string, title = "Test") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;font-family:sans-serif}</style></head><body>${body}</body></html>`;

const loginForm = (error = "") => page(`
  <header><form action="/search"><input name="q" placeholder="Search products"><button>Search</button></form></header>
  <main><h1>ログイン</h1>${error ? `<p class="error">${error}</p>` : ""}
    <form method="post" action="/login">
      <label for="member">会員番号</label><input id="member" name="customerNumber">
      <label for="pw">パスワード</label><input id="pw" type="password" name="password">
      <a href="/forgot">Forgot your password?</a>
      <button type="submit">ログイン</button>
    </form></main>`, "Login");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString("utf8")));
    req.on("end", () => resolve(data));
  });
}

let server: http.Server;
let base = "";
let port = 0;
let browser: Browser;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const signedIn = /(^|;\s*)session=ok/.test(req.headers.cookie ?? "");
    switch (url.pathname) {
      case "/login":
        if (req.method === "POST") {
          const form = new URLSearchParams(await readBody(req));
          if (form.get("customerNumber") === "12345" && form.get("password") === PASSWORD) {
            res.writeHead(302, { location: "/account", "set-cookie": "session=ok; Path=/; HttpOnly" });
            return res.end();
          }
          return html(200, loginForm("Wrong member number or password"));
        }
        return html(200, loginForm());
      case "/account":
        if (!signedIn) {
          res.writeHead(302, { location: "/login?next=%2Faccount" });
          return res.end();
        }
        return html(200, page(`<h1 id="welcome">Welcome member</h1><p>Your orders</p>`));
      case "/home":
        return html(200, page(`<nav><a href="/a">A</a> <a href="/b">B</a></nav><h1>Home</h1>${"<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>".repeat(40)}`));
      case "/members":
        return html(200, page(`<div style="padding:40px"><h2>Members only</h2><form><input name="email" type="email"><input type="password" name="pw"><button>Enter</button></form></div>`));
      case "/private":
        return html(401, page("<h1>Authorization required</h1>"), { "www-authenticate": 'Basic realm="x"' });
      case "/away":
        res.writeHead(302, { location: `http://localhost:${port}/home` });
        return res.end();
      case "/cookies":
        return html(200, page(`<pre id="c">${(req.headers.cookie ?? "").replace(/</g, "&lt;")}</pre>`));
      case "/tall":
        return html(200, page(`<div style="height:20000px;background:linear-gradient(#fff,#09f)">tall</div>`));
      case "/short":
        return html(200, page(`<div style="height:2000px">short</div>`));
      case "/lazy":
        return html(200, page(`
          <style>@keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } } #spin { animation: spin 3s linear infinite; width: 20px; height: 20px; background: red }</style>
          <div id="spin"></div><div style="height:3000px">scroll</div>
          <img id="lazy" loading="lazy" src="/img.png" width="40" height="40" alt="lazy">`));
      case "/img.png":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG_1x1);
      default:
        return html(404, page("not found"));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

const contextFor = (opts: { w?: number; h?: number; policy?: { allowPrivateHosts: boolean }; cookies?: { name: string; value: string }[] } = {}) =>
  newContext(browser, { viewport: { w: opts.w ?? 800, h: opts.h ?? 600 }, cookieUrl: base, policy: opts.policy ?? dev, cookies: opts.cookies });

const pngSize = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

describe("newContext", () => {
  it("emulates a phone below 768 px and a desktop above", async () => {
    const phone = await contextFor({ w: 390, h: 844 });
    const desktop = await contextFor({ w: 1280, h: 800 });
    try {
      const p = await phone.newPage();
      const d = await desktop.newPage();
      // a phone lays out 980 px without a viewport meta, like Safari
      const responsive = '<meta name="viewport" content="width=device-width, initial-scale=1"><p>hi</p>';
      await p.setContent(responsive);
      await d.setContent(responsive);
      const probe = "({ ua: navigator.userAgent, touch: navigator.maxTouchPoints, w: innerWidth, dpr: devicePixelRatio })";
      const ph = (await p.evaluate(probe)) as { ua: string; touch: number; w: number; dpr: number };
      const de = (await d.evaluate(probe)) as { ua: string; touch: number; w: number; dpr: number };
      expect(ph.ua).toMatch(/iPhone/);
      expect(ph.touch).toBeGreaterThan(0);
      expect(ph.w).toBe(390);
      expect(ph.dpr).toBe(1);
      expect(de.ua).not.toMatch(/iPhone/);
      expect(de.touch).toBe(0);
    } finally {
      await phone.close();
      await desktop.close();
    }
  });

  it("sets the cookies of the screen on the site host before the page opens", async () => {
    const context = await contextFor({ cookies: [{ name: "cart_id", value: "c-42" }] });
    try {
      const p = await context.newPage();
      await p.goto(`${base}/cookies`);
      expect(await p.locator("#c").textContent()).toContain("cart_id=c-42");
    } finally {
      await context.close();
    }
  });

  it("aborts a document navigation the policy refuses", async () => {
    const context = await contextFor({ policy: { allowPrivateHosts: false } });
    try {
      const p = await context.newPage();
      await expect(p.goto(`${base}/home`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      await expect(openPage(p, `${base}/home`, { allowPrivateHosts: false })).rejects.toBeInstanceOf(BlockedUrlError);
    } finally {
      await context.close();
    }
  });
});

describe("login", () => {
  it("refuses a login page on another site before opening anything", async () => {
    const context = await contextFor();
    const logs: string[] = [];
    try {
      const account = { loginUrl: "https://evil.example.net/login", username: "12345", password: PASSWORD };
      await expect(login(context, account, base, { policy: dev, log: (m) => void logs.push(m) })).rejects.toThrow(/login refused/);
      expect(context.pages()).toHaveLength(0);
      expect(logs).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("signs in with the heuristics and returns the session cookie", async () => {
    const context = await contextFor();
    const logs: string[] = [];
    try {
      const state = await login(context, { loginUrl: `${base}/login`, username: "12345", password: PASSWORD }, `${base}/`, { policy: dev, log: (m) => void logs.push(m) });
      expect(state.cookies.find((c) => c.name === "session")?.value).toBe("ok");
      expect(context.pages()).toHaveLength(0); // the login page is closed
      expect(logs.join("\n")).not.toContain(PASSWORD);

      // the state opens the members page in a new context
      const next = await newContext(browser, { viewport: { w: 800, h: 600 }, cookieUrl: base, policy: dev, storageState: state });
      const p = await next.newPage();
      await p.goto(`${base}/account`);
      expect(await p.locator("#welcome").textContent()).toBe("Welcome member");
      await next.close();
    } finally {
      await context.close();
    }
  });

  it("signs in with the given selectors and success selector", async () => {
    const context = await contextFor();
    try {
      const state = await login(
        context,
        { loginUrl: `${base}/login`, username: "12345", password: PASSWORD, usernameSelector: "input[name=customerNumber]", passwordSelector: "#pw", submitSelector: "form[method=post] button", successSelector: "Welcome member" },
        base,
        { policy: dev, log: () => undefined },
      );
      expect(state.cookies.some((c) => c.name === "session" && c.value === "ok")).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("fails on a wrong password without showing it", async () => {
    const context = await contextFor();
    try {
      const wrong = "wrong-Pa55word";
      const error = await login(context, { loginUrl: `${base}/login`, username: "12345", password: wrong }, base, { policy: dev, log: () => undefined, timeout: 2_000 }).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/login failed: still on the login page/);
      expect((error as Error).message).not.toContain(wrong);
    } finally {
      await context.close();
    }
  });

  it("knows the registrable domain", () => {
    expect(registrableDomain("www.shop.example.co.jp")).toBe("example.co.jp");
    expect(registrableDomain("login.example.com")).toBe("example.com");
    expect(sameSite("login.example.com", "www.example.com")).toBe(true);
    expect(sameSite("evil.example.net", "www.example.com")).toBe(false);
    expect(sameSite("mine.vercel.app", "theirs.vercel.app")).toBe(false);
    expect(sameSite("a.example.co.uk", "b.other.co.uk")).toBe(false);
  });
});

describe("runSteps", () => {
  const form = page(`
    <button onclick="document.getElementById('menu').hidden = false">Open menu</button>
    <div id="menu" hidden><p>Menu is open</p></div>
    <label>Email <input id="email"></label>
    <label for="size">Size</label><select id="size"><option value="s">Small</option><option value="l">Large</option></select>
    <label><input type="checkbox" id="agree"> I agree</label>
    <input id="q" placeholder="Search here">
    <button data-testid="later" onclick="setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id=done>Done</p>'), 300)">Later</button>
    <ul><li>Item</li><li>Item</li></ul>`);

  it("clicks, fills, selects, checks and waits", async () => {
    const context = await contextFor();
    try {
      const p = await context.newPage();
      await p.setContent(form);
      await runSteps(
        p,
        [
          { action: "click", target: { role: "button", name: "Open menu" } },
          { action: "waitFor", target: { text: "Menu is open" }, state: "visible" },
          { action: "fill", target: { label: "Email" }, value: "a@b.c" },
          { action: "select", target: { label: "Size" }, value: "Large" },
          { action: "check", target: { label: "I agree" }, checked: true },
          { action: "fill", target: { placeholder: "Search here" }, value: "sofa" },
          { action: "click", target: { testId: "later" } },
          { action: "waitFor", target: { css: "#done" }, state: "visible" },
          { action: "hover", target: { text: "Item", nth: 1 } },
          { action: "press", key: "Tab" },
          { action: "scroll", y: 100 },
          { action: "wait", ms: 10 },
        ],
        { baseUrl: base, policy: dev, log: () => undefined },
      );
      expect(await p.inputValue("#email")).toBe("a@b.c");
      expect(await p.inputValue("#size")).toBe("l");
      expect(await p.isChecked("#agree")).toBe(true);
      expect(await p.inputValue("#q")).toBe("sofa");
      expect(await p.isVisible("#menu")).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("throws with the step number and what failed", async () => {
    const context = await contextFor();
    try {
      const p = await context.newPage();
      await p.setContent(form);
      const steps = [
        { action: "click" as const, target: { text: "Open menu" } },
        { action: "click" as const, target: { role: "button", name: "Next" } },
      ];
      await expect(runSteps(p, steps, { baseUrl: base, policy: dev, log: () => undefined, timeout: 1_000 })).rejects.toThrow(
        /^step 2 \(click role=button name=Next\): no element matches role=button name=Next/,
      );
      await expect(
        runSteps(p, [{ action: "select", target: { label: "Size" }, value: "Huge" }], { baseUrl: base, policy: dev, log: () => undefined, timeout: 1_000 }),
      ).rejects.toThrow(/^step 1 \(select label=Size value=Huge\): no option "Huge" \(options: "Small", "Large"\)/);
    } finally {
      await context.close();
    }
  });

  it("goes to a URL of the screen host only", async () => {
    const context = await contextFor();
    try {
      const p = await context.newPage();
      await runSteps(p, [{ action: "goto", url: "/home" }], { baseUrl: `${base}/start`, policy: dev, log: () => undefined });
      expect(p.url()).toBe(`${base}/home`);
      await expect(runSteps(p, [{ action: "goto", url: "https://other.example/x" }], { baseUrl: base, policy: dev, log: () => undefined })).rejects.toThrow(
        /^step 1 \(goto https:\/\/other\.example\/x\): goto refused/,
      );
    } finally {
      await context.close();
    }
  });
});

describe("openPage, settle, screenshot", () => {
  it("caps a full-page screenshot at 16000 px and keeps CSS pixels", async () => {
    const context = await contextFor();
    try {
      const p = await context.newPage();
      const tall = await openPage(p, `${base}/tall`, dev);
      expect(tall.status).toBe(200);
      expect(pngSize(await fullPageScreenshot(p))).toEqual({ w: 800, h: 16000 });
      await openPage(p, `${base}/short`, dev);
      expect(pngSize(await fullPageScreenshot(p))).toEqual({ w: 800, h: 2000 });
    } finally {
      await context.close();
    }
  });

  it("settles: lazy images loaded, animations off, back at the top", async () => {
    const context = await contextFor();
    try {
      const p = await context.newPage();
      const { finalUrl, status } = await openPage(p, `${base}/lazy`, dev);
      expect(finalUrl).toBe(`${base}/lazy`);
      expect(status).toBe(200);
      const state = (await p.evaluate(`(() => {
        const img = document.getElementById("lazy");
        return { loaded: img.complete && img.naturalWidth > 0, duration: getComputedStyle(document.getElementById("spin")).animationDuration, y: scrollY };
      })()`)) as { loaded: boolean; duration: string; y: number };
      expect(state).toEqual({ loaded: true, duration: "0s", y: 0 });
    } finally {
      await context.close();
    }
  });

  it("gives the accessibility tree, capped", async () => {
    const context = await contextFor();
    try {
      const p = await context.newPage();
      await p.setContent(page(`<h1>Shop</h1><button>Buy</button><ul>${"<li>A long list item of the shop</li>".repeat(200)}</ul>`));
      const full = await ariaSnapshot(p);
      expect(full).toContain('heading "Shop"');
      expect(full).toContain('button "Buy"');
      const capped = await ariaSnapshot(p, 500);
      expect(capped.length).toBeLessThanOrEqual(500);
      expect(capped).toMatch(/truncated/);
    } finally {
      await context.close();
    }
  });
});

describe("detectAuthWall", () => {
  const check = async (path: string) => {
    const context = await contextFor();
    try {
      const p = await context.newPage();
      await openPage(p, `${base}${path}`, dev);
      return await detectAuthWall(p, `${base}${path}`);
    } finally {
      await context.close();
    }
  };

  it("sees a redirect to the login page", async () => {
    const wall = await check("/account");
    expect(wall.blocked).toBe(true);
    expect(wall.reason).toMatch(/login page \(\/login\)/);
  });

  it("sees a page that is a password form", async () => {
    const wall = await check("/members");
    expect(wall).toEqual({ blocked: true, reason: expect.stringMatching(/login form/) });
  });

  it("sees HTTP 401", async () => {
    expect((await check("/private")).reason).toMatch(/401/);
  });

  it("sees a redirect to another host", async () => {
    expect((await check("/away")).reason).toMatch(/another host \(localhost:\d+\)/);
  });

  it("lets a normal page and the requested login page through", async () => {
    expect(await check("/home")).toEqual({ blocked: false, reason: null });
    expect(await check("/login")).toEqual({ blocked: false, reason: null });
  });
});
