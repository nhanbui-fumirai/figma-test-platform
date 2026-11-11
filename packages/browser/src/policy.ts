/**
 * URL policy (SSRF guard): the browser of the worker only opens http(s) pages of public hosts. A host is resolved and
 * every address it resolves to must be public: loopback, private (RFC 1918), link-local (with the cloud metadata
 * address 169.254.169.254), carrier-grade NAT, unique-local, unspecified, multicast / reserved and IPv4-mapped IPv6
 * addresses are refused, unless the policy allows private hosts (dev, fixture site).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { UrlPolicy } from "./index";
import { normalizeHost } from "./site";

/** A URL the policy refuses (not http(s), or a private host when they are not allowed). */
export class BlockedUrlError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlockedUrlError";
  }
}

/** http(s) only; the host resolved and refused (BlockedUrlError) when private / loopback / link-local, unless the policy allows it. */
export async function checkUrl(url: string, policy: UrlPolicy): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedUrlError(`not a valid URL: ${shorten(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedUrlError(`only http and https pages can be opened, not ${parsed.protocol.replace(/:$/, "")} (${shorten(url)})`);
  }
  if (parsed.username || parsed.password) throw new BlockedUrlError(`a URL with a user name or password is refused (${parsed.host})`);
  if (policy.allowPrivateHosts) return parsed;

  const host = normalizeHost(parsed.hostname);
  if (!host) throw new BlockedUrlError(`no host in ${shorten(url)}`);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "lookup failed";
      throw new Error(`cannot resolve ${host} (${code})`);
    }
    if (!addresses.length) throw new Error(`cannot resolve ${host} (no address)`);
  }
  for (const address of addresses) {
    const why = addressProblem(address);
    if (why) {
      const via = address === host ? "" : ` resolves to ${address}:`;
      throw new BlockedUrlError(`blocked: ${parsed.host}${via} ${why}; private hosts are not allowed`);
    }
  }
  return parsed;
}

/** Why an IP address is not public, or null. */
export function addressProblem(address: string): string | null {
  const a = normalizeHost(address).replace(/%.*$/, ""); // fe80::1%eth0
  const v4 = parseIPv4(a);
  if (v4) return ipv4Problem(v4);
  const v6 = parseIPv6(a);
  if (v6) return ipv6Problem(v6);
  return "is not a valid IP address";
}

function ipv4Problem(b: number[]): string | null {
  const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = b;
  if (p0 === 0) return "is an unspecified address (0.0.0.0/8)";
  if (p0 === 10) return "is a private address (10.0.0.0/8)";
  if (p0 === 100 && p1 >= 64 && p1 <= 127) return "is a carrier-grade NAT address (100.64.0.0/10)";
  if (p0 === 127) return "is a loopback address (127.0.0.0/8)";
  if (p0 === 169 && p1 === 254) return p2 === 169 && p3 === 254 ? "is the cloud metadata address" : "is a link-local address (169.254.0.0/16)";
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return "is a private address (172.16.0.0/12)";
  if (p0 === 192 && p1 === 168) return "is a private address (192.168.0.0/16)";
  if (p0 === 192 && p1 === 0 && p2 === 0) return "is a reserved address (192.0.0.0/24)";
  if (p0 === 198 && (p1 === 18 || p1 === 19)) return "is a benchmarking address (198.18.0.0/15)";
  if (p0 >= 224) return "is a multicast or reserved address (224.0.0.0/3)";
  return null;
}

function ipv6Problem(h: number[]): string | null {
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  const g = (i: number) => h[i] ?? 0;
  if (zeros(0, 8)) return "is the unspecified address (::)";
  if (zeros(0, 7) && g(7) === 1) return "is the loopback address (::1)";
  if (zeros(0, 5) && g(5) === 0xffff) return "is an IPv4-mapped IPv6 address (::ffff:0:0/96)";
  if (zeros(0, 6)) return "is an IPv4-compatible IPv6 address (::/96)";
  if ((g(0) & 0xfe00) === 0xfc00) return "is a unique-local address (fc00::/7)";
  if ((g(0) & 0xffc0) === 0xfe80) return "is a link-local address (fe80::/10)";
  if ((g(0) & 0xffc0) === 0xfec0) return "is a site-local address (fec0::/10)";
  if ((g(0) & 0xff00) === 0xff00) return "is a multicast address (ff00::/8)";
  if (g(0) === 0x100 && zeros(1, 4)) return "is a discard-only address (100::/64)";
  if (g(0) === 0x2001 && g(1) === 0xdb8) return "is a documentation address (2001:db8::/32)";
  // addresses that carry an IPv4 address: NAT64 (64:ff9b::/96) and 6to4 (2002::/16)
  const embedded = g(0) === 0x64 && g(1) === 0xff9b && zeros(2, 6) ? [g(6) >> 8, g(6) & 0xff, g(7) >> 8, g(7) & 0xff]
    : g(0) === 0x2002 ? [g(1) >> 8, g(1) & 0xff, g(2) >> 8, g(2) & 0xff] : null;
  if (embedded) {
    const why = ipv4Problem(embedded);
    if (why) return `embeds ${embedded.join(".")}, which ${why}`;
  }
  return null;
}

function parseIPv4(s: string): number[] | null {
  if (isIP(s) !== 4) return null;
  return s.split(".").map(Number);
}

/** the 8 groups of an IPv6 address ("::" expanded, an IPv4 tail converted), or null */
function parseIPv6(s: string): number[] | null {
  if (isIP(s) !== 6) return null;
  let text = s;
  const tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1]) {
    const b = v4[1].split(".").map(Number);
    tail.push(((b[0] ?? 0) << 8) | (b[1] ?? 0), ((b[2] ?? 0) << 8) | (b[3] ?? 0));
    text = text.slice(0, -v4[1].length).replace(/:$/, "") || ":";
    if (text.endsWith(":") && !text.endsWith("::")) text += ":";
  }
  const [head = "", rest] = text.split("::");
  const left = head ? head.split(":").filter(Boolean).map((x) => parseInt(x, 16)) : [];
  const right = rest !== undefined && rest ? rest.split(":").filter(Boolean).map((x) => parseInt(x, 16)) : [];
  const fill = 8 - left.length - right.length - tail.length;
  if (rest === undefined && fill !== 0) return null;
  const groups = [...left, ...new Array<number>(Math.max(0, fill)).fill(0), ...right, ...tail];
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null;
}

const shorten = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
