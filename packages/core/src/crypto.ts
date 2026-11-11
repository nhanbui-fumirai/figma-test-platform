/**
 * Secrets at rest (Figma / GitHub tokens, test logins, AI keys): AES-256-GCM with APP_SECRET. Each value gets its own
 * random IV; the auth tag detects any change. keyVersion lets APP_SECRET rotate later (decrypt with the old key, encrypt
 * with the new one).
 */
import crypto from "node:crypto";

export type Sealed = { ciphertext: string; iv: string; tag: string; keyVersion: number };

const KEY_VERSION = 1;

function keyOf(appSecret: string) {
  const key = Buffer.from(appSecret, "base64");
  if (key.length !== 32) throw new Error("APP_SECRET must be 32 bytes (base64)");
  return key;
}

export function seal(plaintext: string, appSecret: string): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(appSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), keyVersion: KEY_VERSION };
}

export function unseal(sealed: Sealed, appSecret: string): string {
  if (sealed.keyVersion !== KEY_VERSION) throw new Error(`secret sealed with key version ${sealed.keyVersion}, this server has ${KEY_VERSION}`);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyOf(appSecret), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** What the UI may show of a secret: its last 4 characters. */
export const hintOf = (secret: string) => (secret.length > 8 ? `…${secret.slice(-4)}` : "…");

/** A random token (session ids) and its hash (what the database keeps). */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
