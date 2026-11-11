/** JSON helpers: deep equality, a canonical text (sorted keys), JSON Pointer (RFC 6901). */

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** JSON text with the keys of every object sorted: equal values, equal texts */
export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v)) ?? "undefined";
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) Object.defineProperty(out, k, { value: sortKeys(v[k]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

export const deepEqual = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** "/data/items/0" -> ["data", "items", "0"]; "" -> [] (the whole document) */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`a JSON Pointer starts with "/" (or is "" for the whole body)`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");
export const toPointer = (tokens: (string | number)[]) => tokens.map((t) => `/${escapeToken(String(t))}`).join("");

/** an array index token: "0", "12" (no sign, no leading zero); "-" is the end of the array where allowed */
export function arrayIndex(token: string, length: number, opts: { allowEnd: boolean }): number {
  if (token === "-" && opts.allowEnd) return length;
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new Error(`"${token}" is not an index of the list`);
  const i = Number(token);
  if (i > length || (i === length && !opts.allowEnd)) throw new Error(`index ${i} is out of the list (${length} items)`);
  return i;
}

/** the value at the pointer, or undefined when it is not there (own properties only) */
export function getAt(doc: unknown, tokens: string[]): unknown {
  let cur: unknown = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(t)) return undefined;
      cur = cur[Number(t)];
    } else if (isRecord(cur)) {
      if (!hasOwn(cur, t)) return undefined;
      cur = cur[t];
    } else return undefined;
  }
  return cur;
}

/** sets an own property (a "__proto__" key stays a plain key) */
export function setOwn(o: Record<string, unknown>, k: string, v: unknown) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

export const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
