/**
 * Host helpers: the registrable domain of a host ("shop.example.co.jp" -> "example.co.jp") without the full Public
 * Suffix List. Two-level public suffixes of country domains (co.uk, com.au, co.jp ...) and the hosting platforms where
 * every subdomain belongs to someone else (vercel.app, github.io ...) are known; a host under one of those is its own
 * site, so a password is never typed on a neighbour's deployment.
 */
import { isIP } from "node:net";

/** second-level labels that are public under a two-letter country TLD (co.uk, com.au, ne.jp, gob.mx ...) */
const GENERIC_SLD = new Set(["co", "com", "net", "org", "ac", "edu", "gov", "go", "or", "ne", "gob", "mil", "ltd", "plc", "sch", "nhs", "gen", "firm", "ind", "info", "biz", "lg", "ad", "ed", "gr", "asn", "id", "in", "nom"]);

/** hosting platforms: every subdomain is a different site (from the private section of the Public Suffix List) */
const PRIVATE_SUFFIXES = [
  "github.io", "gitlab.io", "vercel.app", "now.sh", "netlify.app", "netlify.com", "herokuapp.com", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "appspot.com", "run.app", "a.run.app", "azurewebsites.net", "azurestaticapps.net", "azureedge.net",
  "cloudapp.net", "cloudfront.net", "amplifyapp.com", "elasticbeanstalk.com", "s3.amazonaws.com", "onrender.com", "fly.dev",
  "railway.app", "up.railway.app", "glitch.me", "repl.co", "replit.app", "replit.dev", "ngrok.io", "ngrok.app", "ngrok.dev",
  "ngrok-free.app", "trycloudflare.com", "loca.lt", "deno.dev", "surge.sh", "blogspot.com", "wordpress.com", "myshopify.com",
  "lovable.app", "csb.app", "codesandbox.io", "stackblitz.io", "webcontainer.io", "translate.goog", "storybook.app",
].sort((a, b) => b.length - a.length);

export const normalizeHost = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/** "www.shop.example.co.jp" -> "example.co.jp"; an IP or a single-label host is its own domain. */
export function registrableDomain(hostname: string): string {
  const h = normalizeHost(hostname);
  if (isIP(h) || !h.includes(".")) return h;
  for (const suffix of PRIVATE_SUFFIXES) {
    if (h === suffix) return h;
    if (h.endsWith(`.${suffix}`)) {
      const rest = h.slice(0, -suffix.length - 1).split(".");
      return `${rest[rest.length - 1]}.${suffix}`;
    }
  }
  const labels = h.split(".");
  const tld = labels[labels.length - 1] ?? "";
  const sld = labels[labels.length - 2] ?? "";
  if (labels.length >= 3 && tld.length === 2 && GENERIC_SLD.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

/** same host, or hosts of the same registrable domain (www.example.com and login.example.com) */
export function sameSite(a: string, b: string): boolean {
  const x = normalizeHost(a);
  const y = normalizeHost(b);
  return x === y || registrableDomain(x) === registrableDomain(y);
}

/** example.com and www.example.com are one host for a redirect */
export const sameHostIgnoringWww = (a: string, b: string) => normalizeHost(a).replace(/^www\./, "") === normalizeHost(b).replace(/^www\./, "");

/** the first line of an error message (Playwright adds a call log below) */
export const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim() ?? "";
