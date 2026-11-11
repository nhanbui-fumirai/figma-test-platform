/**
 * Secrets never leave the process in clear: every value registered here (a token, a password, a session) is replaced
 * by *** in log lines and job logs (the SSE stream shows job logs to the browser).
 */
const secrets = new Set<string>();

/** Registers a secret value (short values are ignored: they would mask ordinary words). */
export function registerSecret(value: string | undefined | null) {
  if (value && value.length >= 6) secrets.add(value);
}

/** The text with every registered secret (and its base64 / URL-encoded form) masked. */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    for (const form of [s, Buffer.from(s).toString("base64"), encodeURIComponent(s)]) {
      if (form && out.includes(form)) out = out.split(form).join("***");
    }
  }
  return out;
}

/** A value with every string in it redacted (objects and arrays walked). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object" && !(value instanceof Error)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  if (value instanceof Error) {
    const e = new Error(redact(value.message));
    e.stack = value.stack ? redact(value.stack) : undefined;
    return e as T;
  }
  return value;
}
