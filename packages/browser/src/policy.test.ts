import { describe, expect, it, vi } from "vitest";

// names resolved without the network: a public host, one that also resolves to a private address (rebinding), the
// metadata address behind a friendly name, a name that does not exist
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const table: Record<string, string[]> = {
      "public.test": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
      "mixed.test": ["93.184.216.34", "10.1.2.3"],
      "metadata.test": ["169.254.169.254"],
      "v6local.test": ["fd12:3456::1"],
      localhost: ["127.0.0.1", "::1"],
    };
    const list = table[host];
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
}));

const { checkUrl, BlockedUrlError, addressProblem } = await import("./policy");

const strict = { allowPrivateHosts: false };
const dev = { allowPrivateHosts: true };

describe("checkUrl", () => {
  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://127.0.0.1:3000/",
    "http://localhost/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "http://[::]/",
    "http://10.0.0.1/",
    "http://172.16.5.4/",
    "http://192.168.1.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:8.8.8.8]/",
    "http://[64:ff9b::a00:1]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://metadata.test/",
    "http://mixed.test/",
    "http://v6local.test/",
    "http://user:pw@public.test/",
  ])("refuses %s", async (url) => {
    await expect(checkUrl(url, strict)).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it.each(["http://93.184.216.34/", "https://8.8.8.8/dns", "https://public.test/shop?x=1", "http://[2606:4700:4700::1111]/"])("allows %s", async (url) => {
    const parsed = await checkUrl(url, strict);
    expect(parsed.href).toBe(new URL(url).href);
  });

  it("says why, with the address a name resolves to", async () => {
    await expect(checkUrl("http://metadata.test/x", strict)).rejects.toThrow(/169\.254\.169\.254.*metadata/);
    await expect(checkUrl("http://10.0.0.1/", strict)).rejects.toThrow(/private address/);
  });

  it("allows private hosts when the policy does, but still only http(s)", async () => {
    expect((await checkUrl("http://127.0.0.1:5173/", dev)).port).toBe("5173");
    expect((await checkUrl("http://localhost/", dev)).hostname).toBe("localhost");
    expect((await checkUrl("http://192.168.1.1/", dev)).hostname).toBe("192.168.1.1");
    await expect(checkUrl("file:///etc/passwd", dev)).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("fails on a name that does not resolve (not a policy refusal)", async () => {
    const error = await checkUrl("http://nowhere.test/", strict).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BlockedUrlError);
    expect(String(error)).toMatch(/ENOTFOUND/);
  });

  it("classifies addresses", () => {
    expect(addressProblem("8.8.8.8")).toBeNull();
    expect(addressProblem("2001:4860:4860::8888")).toBeNull();
    expect(addressProblem("::ffff:7f00:1")).toMatch(/IPv4-mapped/);
    expect(addressProblem("2002:0a00:0001::1")).toMatch(/embeds 10\.0\.0\.1/);
    expect(addressProblem("fe80::1%eth0")).toMatch(/link-local/);
    expect(addressProblem("224.0.0.1")).toMatch(/multicast/);
  });
});
