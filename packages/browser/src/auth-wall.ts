import type { Page } from "playwright";
import { evaluateWithin } from "./network";
import { documentStatus } from "./page";
import { normalizeHost, sameHostIgnoringWww } from "./site";

/** sign-in hosts of identity providers and access proxies: the screen is behind a login */
const SSO_HOSTS: [RegExp, string][] = [
  [/(^|\.)cloudflareaccess\.com$/, "Cloudflare Access"],
  [/^login\.microsoftonline\.(com|us)$|^login\.live\.com$|^login\.windows\.net$|(^|\.)b2clogin\.com$/, "Microsoft"],
  [/^accounts\.google\.com$/, "Google"],
  [/(^|\.)okta(preview|-emea)?\.com$/, "Okta"],
  [/(^|\.)auth0\.com$/, "Auth0"],
  [/(^|\.)onelogin\.com$/, "OneLogin"],
  [/(^|[.-])keycloak([.-]|$)/, "Keycloak"],
  [/(^|\.)amazoncognito\.com$/, "Amazon Cognito"],
  [/(^|\.)awsapps\.com$/, "AWS IAM Identity Center"],
  [/(^|\.)ping(one|identity)\.(com|eu|asia|ca)$/, "Ping Identity"],
  [/(^|\.)duosecurity\.com$/, "Duo"],
  [/(^|\.)jumpcloud\.com$/, "JumpCloud"],
  [/(^|\.)fusionauth\.io$/, "FusionAuth"],
  [/(^|\.)clerk\.accounts\.dev$|(^|\.)accounts\.dev$/, "Clerk"],
  [/(^|\.)workos\.com$|(^|\.)authkit\.app$/, "WorkOS"],
  [/(^|\.)zitadel\.cloud$/, "Zitadel"],
  [/(^|\.)authing\.cn$/, "Authing"],
  [/(^|\.)salesforce\.com$|(^|\.)force\.com$/, "Salesforce"],
];

/** paths of login pages and identity provider endpoints */
const LOGIN_PATH =
  /(^|\/)(log-?in|log_in|sign-?in|sign_in|signon|auth|authenticate|authorize|sso|saml2?|oauth2?|openid-connect|cas|session\/new|sessions?\/new|wp-login\.php|account\/login|users\/sign_in|ログイン)(\/|$|\.|\?|;)/i;

/** The requested URL itself is a login page: a password field there is the screen, not a wall. */
const isLoginPath = (url: URL) => LOGIN_PATH.test(decodeSafe(url.pathname));

const PASSWORD_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0; };
  const pw = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  if (!pw.length) return { password: false };
  const first = pw[0];
  const box = first.form || first.closest("form, dialog, [role=dialog], [aria-modal=true], main, section") || first.parentElement;
  const len = (el) => ((el && el.innerText) || "").replace(/\\s+/g, " ").trim().length;
  const bodyText = len(document.body);
  return {
    password: true,
    top: first.getBoundingClientRect().top + scrollY,
    viewportH: innerHeight,
    pageH: (document.scrollingElement || document.documentElement).scrollHeight,
    outside: Math.max(0, bodyText - len(box)),
    inDialog: !!first.closest("dialog[open], [role=dialog], [aria-modal=true]"),
  };
})()`;

const STATUS_JS = `(() => { const n = performance.getEntriesByType("navigation")[0]; return n && n.responseStatus ? n.responseStatus : null; })()`;

/**
 * Is the page an auth wall instead of the screen (a login form, an SSO / Cloudflare Access page, a redirect to another
 * host or to a login path)? blocked = true makes the result "blocked": no score.
 */
export async function detectAuthWall(page: Page, requestedUrl: string): Promise<{ blocked: boolean; reason: string | null }> {
  const blocked = (reason: string) => ({ blocked: true, reason });
  let final: URL | null = null;
  let requested: URL | null = null;
  try {
    final = new URL(page.url());
  } catch {
    /* about:blank */
  }
  try {
    requested = new URL(requestedUrl);
  } catch {
    /* not absolute */
  }

  if (final && /^https?:$/.test(final.protocol)) {
    const host = normalizeHost(final.hostname);
    const sso = SSO_HOSTS.find(([re]) => re.test(host));
    if (sso) return blocked(`the page went to the ${sso[1]} sign-in page (${host}) instead of the screen: the site is behind a login`);
    if (/^(github\.com|gitlab\.com|vercel\.com|bitbucket\.org)$/.test(host) && LOGIN_PATH.test(final.pathname)) {
      return blocked(`the page went to the sign-in page of ${host} instead of the screen: the site is behind a login`);
    }
    if (requested && !sameHostIgnoringWww(final.hostname, requested.hostname)) {
      return blocked(`the page was redirected to another host (${final.host}) instead of ${requested.host}: a login or an access check is in the way`);
    }
  }

  const known = documentStatus.get(page);
  const status = known && known.url === page.url() ? known.status : await evaluateWithin<number | null>(page, STATUS_JS, 3_000);
  if (status === 401) return blocked("the page answered HTTP 401 (authentication required)");
  if (status === 403) return blocked("the page answered HTTP 403 (forbidden): an access rule or a bot check refused the test browser");

  const askedLogin = requested ? isLoginPath(requested) : false;
  if (final && !askedLogin && isLoginPath(final) && (!requested || final.pathname !== requested.pathname)) {
    return blocked(`the page was redirected to a login page (${final.pathname}) instead of the screen`);
  }

  if (!askedLogin) {
    const pw = await evaluateWithin<{ password: boolean; top?: number; viewportH?: number; pageH?: number; outside?: number; inDialog?: boolean }>(page, PASSWORD_JS, 5_000);
    if (pw?.password) {
      const vh = pw.viewportH || 800;
      const nearTop = (pw.top ?? 0) < vh * 1.2;
      const dominates = pw.inDialog || (nearTop && ((pw.outside ?? 0) < 1_200 || (pw.pageH ?? 0) < vh * 1.6));
      if (dominates) return blocked("the page shows a login form (a password field) instead of the screen");
    }
  }
  return { blocked: false, reason: null };
}

function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
