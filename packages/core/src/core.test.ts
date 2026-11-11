import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkKey, FsBlobStore } from "./blob";
import { hintOf, seal, unseal } from "./crypto";
import { redact, redactDeep, registerSecret } from "./redact";

const key = crypto.randomBytes(32).toString("base64");

describe("crypto", () => {
  it("round-trips a secret", () => {
    const sealed = seal("ghp_secretToken123", key);
    expect(sealed.ciphertext).not.toContain("ghp_");
    expect(unseal(sealed, key)).toBe("ghp_secretToken123");
  });

  it("refuses a changed ciphertext or another key", () => {
    const sealed = seal("value", key);
    expect(() => unseal({ ...sealed, ciphertext: Buffer.from("other").toString("base64") }, key)).toThrow();
    expect(() => unseal(sealed, crypto.randomBytes(32).toString("base64"))).toThrow();
  });

  it("hints only the end", () => {
    expect(hintOf("ghp_abcdefgh1234")).toBe("…1234");
  });
});

describe("redact", () => {
  it("masks a registered secret, its base64 and URL forms", () => {
    registerSecret("s3cr3t-token/+=");
    expect(redact("token=s3cr3t-token/+= ok")).toBe("token=*** ok");
    expect(redact(Buffer.from("s3cr3t-token/+=").toString("base64"))).toBe("***");
    expect(redact(encodeURIComponent("s3cr3t-token/+="))).toBe("***");
    expect(redactDeep({ a: ["x s3cr3t-token/+="] })).toEqual({ a: ["x ***"] });
  });
});

describe("blob store", () => {
  it("puts, gets and deletes by prefix", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blobs-"));
    const store = new FsBlobStore(root);
    await store.put("projects/p1/a.json", "{}");
    expect((await store.get("projects/p1/a.json")).toString()).toBe("{}");
    await store.deletePrefix("projects/p1");
    expect(await store.exists("projects/p1/a.json")).toBe(false);
  });

  it("refuses keys that are not portable", () => {
    expect(() => checkKey("../x")).toThrow();
    expect(() => checkKey("frames/1:2.png")).toThrow();
    expect(() => checkKey("Frames/a.png")).toThrow();
    expect(checkKey("frames/1-2.png")).toBe("frames/1-2.png");
  });
});
