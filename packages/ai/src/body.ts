/**
 * Internal: the trimmed view of a recorded body shown to the model (its paths stay the paths of the real body), the
 * lengths of its lists, and a dry run of mock ops on the real body (paths that exist, lists where a list is needed).
 */
import type { MockOp } from "@figtest/contracts";

export interface TrimOptions {
  /** items shown per list (the first ones; their indexes are the real ones) */
  items: number;
  /** longer strings are cut */
  chars: number;
  /** deeper values are replaced by a marker */
  depth: number;
}

export const TRIM_DEFAULT: TrimOptions = { items: 3, chars: 200, depth: 30 };

/** The marker that ends a list longer than opts.items (it is not in the real body). */
export const moreItems = (more: number, length: number) => `…${more} more items (the list has ${length})`;

/** A copy of the body with lists cut to their first items (+ a marker) and long strings cut. */
export function trimBody(value: unknown, opts: TrimOptions = TRIM_DEFAULT, depth = 0): unknown {
  if (typeof value === "string") return value.length > opts.chars ? `${value.slice(0, opts.chars)}…(+${value.length - opts.chars} chars)` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= opts.depth) return "…(deeper values not shown)";
  if (Array.isArray(value)) {
    const head = value.slice(0, opts.items).map((v) => trimBody(v, opts, depth + 1));
    if (value.length > opts.items) head.push(moreItems(value.length - opts.items, value.length));
    return head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = trimBody(v, opts, depth + 1);
  return out;
}

/** "/data/items: 50 items" for each list of the body (within the items the view shows), at most max lines. */
export function listLengths(body: unknown, opts: TrimOptions = TRIM_DEFAULT, max = 150): string[] {
  const lines: string[] = [];
  let more = 0;
  const walk = (v: unknown, ptr: string, depth: number) => {
    if (v === null || typeof v !== "object" || depth >= opts.depth) return;
    if (Array.isArray(v)) {
      if (lines.length < max) lines.push(`${ptr || '"" (the body)'}: ${v.length} item${v.length === 1 ? "" : "s"}`);
      else more++;
      v.slice(0, opts.items).forEach((x, i) => walk(x, `${ptr}/${i}`, depth + 1));
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${ptr}/${escapeToken(k)}`, depth + 1);
  };
  walk(body, "", 0);
  if (more) lines.push(`(${more} more lists)`);
  return lines;
}

/** The trimmed view as JSON, smaller options until it fits maxChars (then cut). */
export function bodyView(body: unknown, maxChars = 40_000): { json: string; lists: string[]; opts: TrimOptions } {
  const tries: TrimOptions[] = [TRIM_DEFAULT, { items: 2, chars: 100, depth: 20 }, { items: 1, chars: 60, depth: 12 }];
  let last = { json: "", lists: [] as string[], opts: TRIM_DEFAULT };
  for (const opts of tries) {
    const json = JSON.stringify(trimBody(body, opts), null, 1) ?? "null";
    last = { json, lists: listLengths(body, opts), opts };
    if (json.length <= maxChars) return last;
  }
  return { ...last, json: `${last.json.slice(0, maxChars)}\n…(view cut: ${last.json.length - maxChars} more characters)` };
}

// ---------------------------------------------------------------- JSON Pointer (RFC 6901)

export const escapeToken = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** The reference tokens of a pointer ("" = the whole body), or why it is not a pointer. */
export function parsePointer(path: string): string[] | { error: string } {
  if (path === "") return [];
  if (!path.startsWith("/")) return { error: 'a JSON Pointer starts with "/" ("" is the whole body)' };
  const tokens = path.slice(1).split("/");
  for (const t of tokens) if (/~[^01]|~$/.test(t)) return { error: `bad escape in "${t}" (~0 is "~", ~1 is "/")` };
  return tokens.map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v);
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function listIndex(token: string, length: number, at: string): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new Error(`"${token}" is not an index of the list at ${at || '""'}`);
  const i = Number(token);
  if (i >= length) throw new Error(`${at}/${token} does not exist (the list has ${length} items)`);
  return i;
}

type Container = unknown[] | Record<string, unknown>;

function isContainer(v: unknown): v is Container {
  return v !== null && typeof v === "object";
}

/** The value at the tokens (each one must exist). */
function resolve(root: unknown, tokens: string[]): unknown {
  let cur = root;
  let at = "";
  for (const t of tokens) {
    if (Array.isArray(cur)) cur = cur[listIndex(t, cur.length, at)];
    else if (isContainer(cur)) {
      if (!Object.hasOwn(cur, t)) throw new Error(`${at}/${escapeToken(t)} does not exist`);
      cur = (cur as Record<string, unknown>)[t];
    } else throw new Error(`${at || '""'} is ${kindOf(cur)}, not an object or a list`);
    at += `/${escapeToken(t)}`;
  }
  return cur;
}

function parentOf(root: unknown, tokens: string[]): { parent: Container; key: string; at: string } {
  const parentTokens = tokens.slice(0, -1);
  const parent = resolve(root, parentTokens);
  const at = parentTokens.map((t) => `/${escapeToken(t)}`).join("");
  if (!isContainer(parent)) throw new Error(`${at || '""'} is ${kindOf(parent)}, not an object or a list`);
  return { parent, key: tokens[tokens.length - 1] ?? "", at };
}

function applyOne(root: unknown, op: MockOp, tokens: string[]): unknown {
  switch (op.op) {
    case "set": {
      if (op.value === undefined) throw new Error("set needs a value");
      if (!tokens.length) return clone(op.value);
      const { parent, key, at } = parentOf(root, tokens);
      if (Array.isArray(parent)) parent[listIndex(key, parent.length, at)] = clone(op.value);
      else (parent as Record<string, unknown>)[key] = clone(op.value);
      return root;
    }
    case "remove": {
      if (!tokens.length) throw new Error("the whole body cannot be removed");
      const { parent, key, at } = parentOf(root, tokens);
      if (Array.isArray(parent)) parent.splice(listIndex(key, parent.length, at), 1);
      else {
        if (!Object.hasOwn(parent, key)) throw new Error(`${at}/${escapeToken(key)} does not exist`);
        delete parent[key];
      }
      return root;
    }
    case "insert": {
      if (op.value === undefined) throw new Error("insert needs a value");
      const list = resolve(root, tokens);
      if (!Array.isArray(list)) throw new Error(`insert needs a list, ${op.path || '""'} is ${kindOf(list)}`);
      if (op.index > list.length) throw new Error(`index ${op.index} is past the end (the list has ${list.length} items; ${list.length} appends)`);
      list.splice(op.index, 0, clone(op.value));
      return root;
    }
    case "duplicate": {
      const list = resolve(root, tokens);
      if (!Array.isArray(list)) throw new Error(`duplicate needs a list, ${op.path || '""'} is ${kindOf(list)}`);
      if (op.index >= list.length) throw new Error(`item ${op.index} does not exist (the list has ${list.length} items)`);
      const copies = Array.from({ length: op.count }, () => clone(list[op.index]));
      list.splice(op.index + 1, 0, ...copies);
      return root;
    }
  }
}

/**
 * Dry run of the ops, in order, on a copy of the real body: the problems ("ops[3] (set "/items/60/name"): /items/60 does
 * not exist (the list has 50 items)"); [] when every op applies.
 */
export function checkOps(body: unknown, ops: MockOp[], max = 12): string[] {
  let root: unknown = clone(body);
  const problems: string[] = [];
  ops.forEach((op, i) => {
    const where = `ops[${i}] (${op.op} ${JSON.stringify(op.path)})`;
    const tokens = parsePointer(op.path);
    if (!Array.isArray(tokens)) {
      problems.push(`${where}: ${tokens.error}`);
      return;
    }
    try {
      root = applyOne(root, op, tokens);
    } catch (e) {
      problems.push(`${where}: ${(e as Error).message}`);
    }
  });
  return problems.length > max ? [...problems.slice(0, max), `(${problems.length - max} more problems)`] : problems;
}
