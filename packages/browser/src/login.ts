import type { BrowserContext, Locator, Page, Route } from "playwright";
import type { TestLogin } from "@figtest/contracts";
import type { LogFn, StorageState, UrlPolicy } from "./index";
import { checkUrl } from "./policy";
import { firstLine, normalizeHost, sameSite } from "./site";

const FIELD_TIMEOUT = 10_000;
const SUCCESS_TIMEOUT = 30_000;
const MARK = "data-figtest-login";

/**
 * Logs in with the test account in a context and returns its storage state. Refuses (throws) when the host of
 * loginUrl is not the host of siteUrl or a host of the same registrable domain: the password is never typed elsewhere.
 * The password is never logged.
 */
export async function login(
  context: BrowserContext,
  account: TestLogin,
  siteUrl: string,
  opts: { policy: UrlPolicy; log: LogFn; /** ms to wait for the signed-in page (default 30 s) */ timeout?: number },
): Promise<StorageState> {
  const hide = secretHider(account.password);
  let loginUrl: URL;
  let site: URL;
  try {
    loginUrl = new URL(account.loginUrl);
    site = new URL(siteUrl);
  } catch {
    throw new Error("login refused: the login URL or the site URL is not a valid URL");
  }
  // before anything opens: the password is only typed on the website under test
  if (!sameSite(loginUrl.hostname, site.hostname)) {
    throw new Error(`login refused: the login page is on ${loginUrl.host}, not on ${site.host} or a host of its domain; the password of the test account is only typed on the website under test`);
  }
  if (loginUrl.protocol !== "http:" && loginUrl.protocol !== "https:") throw new Error("login refused: the login URL must be http(s)");
  await checkUrl(loginUrl.href, opts.policy);

  const page = await context.newPage();
  const leaks = new Set<string>();
  try {
    // while signing in, nothing that could carry the login goes to another site (a POST, or the password in the URL)
    await page.route("**/*", (route) => guardRequest(route, site.hostname, account.password, leaks));
    await opts.log(`login: opening the login page of ${loginUrl.host}${loginUrl.pathname}`, "info");
    await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);

    let password = await passwordField(page, account, FIELD_TIMEOUT);
    if (!password) {
      // two-step sign-in: the user name first, then the password on the next screen
      const user = await usernameField(page, account);
      if (!user) throw new Error("login: no password field and no user name field on the login page (set the selectors of the test login)");
      await user.fill(account.username, { timeout: FIELD_TIMEOUT });
      await submit(page, user, account.submitSelector);
      password = await passwordField(page, account, 15_000);
      if (!password) throw new Error("login: no password field after sending the user name (set the selectors of the test login)");
    } else {
      const user = await usernameField(page, account);
      if (!user) throw new Error("login: no user name field next to the password field (set usernameSelector)");
      await user.fill(account.username, { timeout: FIELD_TIMEOUT });
    }
    await password.fill(account.password, { timeout: FIELD_TIMEOUT });
    await submit(page, password, account.submitSelector);

    await waitForSignedIn(page, account, loginUrl, opts.timeout ?? SUCCESS_TIMEOUT, leaks);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const state = await context.storageState();
    await opts.log(`login: signed in on ${site.host} with the test account`, "info");
    return state;
  } catch (e) {
    // a Playwright message may quote what was typed: the password never leaves in an error
    const message = hide(e instanceof Error ? e.message : String(e)).split("\nCall log:")[0]?.trim() ?? "login failed";
    throw new Error(message.startsWith("login") ? message : `login failed: ${message}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** aborts a request to another site that could carry the login; the host is reported */
async function guardRequest(route: Route, siteHost: string, password: string, leaks: Set<string>) {
  const request = route.request();
  let host = "";
  try {
    host = new URL(request.url()).hostname;
  } catch {
    return route.fallback();
  }
  if (!host || sameSite(host, siteHost)) return route.fallback();
  const encoded = [password, encodeURIComponent(password), encodeURIComponent(password).replace(/%20/g, "+")];
  const body = request.postData() ?? "";
  const carries = request.method() !== "GET" || encoded.some((p) => request.url().includes(p) || body.includes(p));
  if (!carries) return route.fallback();
  leaks.add(normalizeHost(host));
  return route.abort("blockedbyclient");
}

async function passwordField(page: Page, account: TestLogin, timeout: number): Promise<Locator | null> {
  const loc = account.passwordSelector ? page.locator(account.passwordSelector).first() : page.locator('input[type="password"]').filter({ visible: true }).first();
  try {
    await loc.waitFor({ state: "visible", timeout });
    return loc;
  } catch (e) {
    if (account.passwordSelector && !/Timeout/i.test(firstLine(e))) throw e; // a bad selector
    return null;
  }
}

async function usernameField(page: Page, account: TestLogin): Promise<Locator | null> {
  if (account.usernameSelector) {
    const loc = page.locator(account.usernameSelector).first();
    await loc.waitFor({ state: "visible", timeout: FIELD_TIMEOUT });
    return loc;
  }
  const found = (await page.evaluate(MARK_FIELDS_JS)) as { user: boolean; submit: boolean };
  return found.user ? page.locator(`[${MARK}="user"]`).first() : null;
}

/** the submit selector, else the button marked by MARK_FIELDS_JS, else Enter in the field */
async function submit(page: Page, field: Locator, submitSelector: string | undefined) {
  if (submitSelector) {
    await page.locator(submitSelector).first().click({ timeout: FIELD_TIMEOUT });
    return;
  }
  const found = (await page.evaluate(MARK_FIELDS_JS)) as { user: boolean; submit: boolean };
  const button = page.locator(`[${MARK}="submit"]`).first();
  if (found.submit && (await button.isVisible().catch(() => false))) await button.click({ timeout: FIELD_TIMEOUT });
  else await field.press("Enter", { timeout: FIELD_TIMEOUT });
}

/** successSelector (a selector or a text) shows, else the URL left the login page and no password field is visible */
async function waitForSignedIn(page: Page, account: TestLogin, loginUrl: URL, timeout: number, leaks: Set<string>) {
  const failed = (what: string) => {
    const leak = leaks.size ? ` The login page sends it to ${[...leaks].join(", ")}, another site: refused.` : "";
    return new Error(`login failed: ${what} after ${Math.round(timeout / 1000)} s. Check the test account and the selectors of the test login.${leak}`);
  };
  const success = account.successSelector?.trim();
  if (success) {
    let loc = page.getByText(success);
    try {
      await page.locator(success).count(); // throws when it is not a selector: then it is a text
      loc = page.locator(success).or(page.getByText(success));
    } catch {
      /* a text */
    }
    try {
      await loc.first().waitFor({ state: "visible", timeout });
    } catch {
      throw failed(`${JSON.stringify(success)} did not show`);
    }
    return;
  }
  const deadline = Date.now() + timeout;
  const passwordShown = page.locator('input[type="password"]').filter({ visible: true });
  while (Date.now() < deadline) {
    let left = false;
    try {
      left = new URL(page.url()).pathname !== loginUrl.pathname;
    } catch {
      /* navigating */
    }
    if (left && (await passwordShown.count().catch(() => 1)) === 0) return;
    await page.waitForTimeout(250);
  }
  throw failed(`still on the login page (${loginUrl.pathname})`);
}

/** replaces the secret (and its URL / form encodings) in a text */
function secretHider(secret: string) {
  const forms = [...new Set([secret, encodeURIComponent(secret), encodeURIComponent(secret).replace(/%20/g, "+"), JSON.stringify(secret).slice(1, -1)])].filter(Boolean);
  return (text: string) => forms.reduce((t, f) => t.split(f).join("***"), text);
}

/**
 * Finds the user name field and the submit button of a login form and marks them (MARK attribute): inputs scored by
 * autocomplete, type, name / id / label / placeholder (user, email, login, account, member, customer, id, 会員番号 ...),
 * same form as the password field and placed before it; buttons by type submit and their text (log in, sign in, next ...).
 */
const MARK_FIELDS_JS = `(() => {
  const MARK = ${JSON.stringify(MARK)};
  const USER = /user|e-?mail|mail|login|log-in|signin|account|member|customer|client|card|(^|[^a-z])id($|[^a-z])|userid|loginid|会員|メール|ユーザ|ログイン|お客様|番号|ＩＤ|아이디|账号|帐号|用户|邮箱/i;
  const NOT_USER = /search|query|keyword|検索|coupon|promo|zip|postal|captcha|otp|code/i;
  const SUBMIT = /log ?in|sign ?in|submit|continue|next|enter|ログイン|サインイン|次へ|続行|送信|認証|登录|登入|로그인|connexion|anmelden|entrar|iniciar|accedi/i;
  const NOT_SUBMIT = /forgot|reset|register|sign ?up|create|join|cancel|back|忘れ|新規|登録|戻る|google|facebook|apple|line|twitter|github|microsoft/i;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled; };
  const textOf = (el) => {
    const parts = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.getAttribute("autocomplete"), el.getAttribute("title")];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const by = el.getAttribute("aria-labelledby");
    if (by) for (const id of by.split(/\\s+/)) { const x = document.getElementById(id); if (x) parts.push(x.textContent); }
    return parts.filter(Boolean).join(" ").replace(/\\s+/g, " ");
  };
  for (const el of document.querySelectorAll("[" + MARK + "]")) el.removeAttribute(MARK);
  const pw = [...document.querySelectorAll('input[type="password"]')].find(visible) || null;
  const types = ["", "text", "email", "tel", "number"];
  let user = null, best = 0;
  for (const el of document.querySelectorAll("input")) {
    if (!types.includes((el.getAttribute("type") || "").toLowerCase()) || !visible(el) || el.readOnly) continue;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    const text = textOf(el);
    let s = 1;
    if (/\\busername\\b/.test(ac)) s += 100; else if (/\\bemail\\b/.test(ac)) s += 80;
    if ((el.getAttribute("type") || "").toLowerCase() === "email") s += 60;
    if (USER.test(text)) s += 50;
    if (NOT_USER.test(text)) s -= 200;
    if (pw) {
      if (pw.form && el.form === pw.form) s += 30;
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) s += 20; else s -= 40;
    } else if (!USER.test(text) && !/username|email/.test(ac) && (el.getAttribute("type") || "") !== "email") s -= 100;
    if (s > best) { best = s; user = el; }
  }
  if (user) user.setAttribute(MARK, "user");
  const scope = (pw && pw.form) || (user && user.form) || document;
  const anchor = pw || user;
  let button = null, top = 0;
  for (const el of scope.querySelectorAll('button, input[type="submit"], input[type="image"], [role="button"]')) {
    if (!visible(el)) continue;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const text = ((el.innerText || el.value || "") + " " + (el.getAttribute("aria-label") || "")).trim();
    let s = 1;
    if (type === "submit" || (el.tagName === "BUTTON" && el.form && !type)) s += 50;
    if (SUBMIT.test(text)) s += 40;
    if (NOT_SUBMIT.test(text)) s -= 200;
    if (anchor && anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) s += 10;
    if (s > top) { top = s; button = el; }
  }
  if (button && top > 1) button.setAttribute(MARK, "submit");
  return { user: !!user, submit: !!button && top > 1 };
})()`;
