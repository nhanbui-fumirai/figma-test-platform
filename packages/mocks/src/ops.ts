/**
 * The edits of a recorded body (AI or human), addressed by JSON Pointer (RFC 6901, "" = the whole body):
 *   set        replaces (or adds) the value at path; in a list, index = length (or "-") appends
 *   remove     deletes the key / the list item at path
 *   insert     inserts value into the list at path, before index (index = length appends)
 *   duplicate  copies the item at index of the list at path, count times, right after it
 *
 * Guards of applyOpsChecked, so the page keeps getting data it can parse:
 *   - kinds: a value keeps the kind of the value it replaces (or of the other items of its list): number, boolean,
 *     string, object, list; an ISO date / date-time / time string stays one; a code-like string ("NRT", "A12",
 *     "ANA123", "1200") keeps its pattern (letters / digits / separators); an enum-like string ("NO_SMOKING", the value
 *     of a status / type / kind / mode / state ... key) keeps a value seen for that key in the recorded body. Free-text
 *     keys (name, title, label, description ...) take any string. null is always accepted.
 *   - distinct items: after the ops, no list has two equal records (objects) that the recorded list did not have.
 * A refused op is skipped (the next ops apply to the body without it) and explained in `violations`.
 */
import type { MockOp } from "@figtest/contracts";
import { arrayIndex, canonical, escapeToken, getAt, hasOwn, isRecord, kindOf, parsePointer, setOwn } from "./json";
import type { OpsResult } from "./types";

/** recorded + ops, no guard (throws on a bad path). The recorded value is not changed. */
export function applyOps(recorded: unknown, ops: MockOp[]): unknown {
  let doc = clone(recorded);
  for (const op of ops) doc = applyOne(doc, op);
  return doc;
}

/**
 * recorded + the ops that pass the guards: a value keeps its kind (number stays number, ISO date stays an ISO date,
 * a code like "NRT" or "A12" stays the same pattern, enum-like strings keep a value seen in the body), and the items
 * of a list stay distinct (no two equal records). A whole-body set (path "") is checked node by node the same way.
 */
export function applyOpsChecked(recorded: unknown, ops: MockOp[]): OpsResult {
  const enums = enumValues(recorded);
  const distinct = new Map<number, string>(); // op index -> why the distinct guard refused it
  for (;;) {
    const result = runGuarded(recorded, ops, distinct, enums);
    const dup = newDuplicate(recorded, result.doc);
    const culprit = dup ? lastIncrease(recorded, ops, result.applied, dup.pointer) : null;
    if (!dup || culprit === null) {
      const violations = ops.map((_, i) => distinct.get(i) ?? result.problems.get(i)).filter((v): v is string => !!v);
      if (dup) violations.push(`${dup.pointer || '""'}: items ${dup.i} and ${dup.j} are the same record (the items of a list stay distinct)`);
      return { body: result.doc, violations };
    }
    const op = ops[culprit] as MockOp;
    distinct.set(culprit, `${op.path || '""'}: ${op.op} refused: items ${dup.i} and ${dup.j} of ${dup.pointer || "the body"} would be the same record (the items of a list stay distinct)`);
  }
}

// ---------------------------------------------------------------- applying

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

const where = (path: string) => (path === "" ? '""' : path);

/** applies one op to doc (changed in place) and returns the new root; throws without changing anything on a bad path */
function applyOne(doc: unknown, op: MockOp): unknown {
  const tokens = parsePointerOf(op.path);
  switch (op.op) {
    case "set": {
      const value = clone(op.value);
      if (!tokens.length) return value;
      const { parent, key } = parentOf(doc, tokens, op.path);
      if (Array.isArray(parent)) {
        const i = indexIn(key, parent.length, true, op.path);
        if (i === parent.length) parent.push(value);
        else parent[i] = value;
      } else setOwn(parent, key, value);
      return doc;
    }
    case "remove": {
      if (!tokens.length) throw new Error(`"": the whole body cannot be removed (set it to another value)`);
      const { parent, key } = parentOf(doc, tokens, op.path);
      if (Array.isArray(parent)) parent.splice(indexIn(key, parent.length, false, op.path), 1);
      else {
        if (!hasOwn(parent, key)) throw new Error(`${op.path}: nothing to remove`);
        delete parent[key];
      }
      return doc;
    }
    case "insert": {
      const list = listAt(doc, tokens, op.path);
      if (!Number.isInteger(op.index) || op.index < 0 || op.index > list.length) throw new Error(`${where(op.path)}: index ${op.index} is out of the list (${list.length} items)`);
      list.splice(op.index, 0, clone(op.value));
      return doc;
    }
    case "duplicate": {
      const list = listAt(doc, tokens, op.path);
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= list.length) throw new Error(`${where(op.path)}: no item ${op.index} to duplicate (${list.length} items)`);
      const count = Math.max(1, Math.min(op.count ?? 1, 1000));
      const item = list[op.index];
      list.splice(op.index + 1, 0, ...Array.from({ length: count }, () => clone(item)));
      return doc;
    }
    default: {
      const unknown: never = op;
      throw new Error(`unknown op ${JSON.stringify((unknown as { op?: unknown }).op)}`);
    }
  }
}

function parsePointerOf(path: string): string[] {
  try {
    return parsePointer(path);
  } catch (e) {
    throw new Error(`${where(path)}: ${(e as Error).message}`);
  }
}

function indexIn(token: string, length: number, allowEnd: boolean, path: string): number {
  try {
    return arrayIndex(token, length, { allowEnd });
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

function parentOf(doc: unknown, tokens: string[], path: string): { parent: Record<string, unknown> | unknown[]; key: string } {
  const parent = getAt(doc, tokens.slice(0, -1));
  if (!Array.isArray(parent) && !isRecord(parent)) throw new Error(`${path}: no such place in the body (${toParent(tokens)} is not an object or a list)`);
  return { parent, key: tokens[tokens.length - 1] ?? "" };
}

function listAt(doc: unknown, tokens: string[], path: string): unknown[] {
  const list = getAt(doc, tokens);
  if (!Array.isArray(list)) throw new Error(`${where(path)}: not a list (${kindOf(list) === "undefined" ? "nothing there" : kindOf(list)})`);
  return list;
}

const toParent = (tokens: string[]) => where(tokens.slice(0, -1).map((t) => `/${escapeToken(t)}`).join(""));

// ---------------------------------------------------------------- guards

/** the ops in order, each one checked against the body as the earlier ops left it; `skip` ops are left out */
function runGuarded(recorded: unknown, ops: MockOp[], skip: Map<number, string>, enums: Map<string, Set<string>>) {
  let doc = clone(recorded);
  const applied: number[] = [];
  const problems = new Map<number, string>();
  ops.forEach((op, i) => {
    if (skip.has(i)) return;
    let problem: string | null;
    try {
      problem = kindProblem(doc, op, enums);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (problem) {
      problems.set(i, problem);
      return;
    }
    try {
      doc = applyOne(doc, op);
      applied.push(i);
    } catch (e) {
      problems.set(i, (e as Error).message);
    }
  });
  return { doc, applied, problems };
}

/** why the value of a set / insert cannot stand where it goes, or null */
function kindProblem(doc: unknown, op: MockOp, enums: Map<string, Set<string>>): string | null {
  const tokens = parsePointerOf(op.path);
  if (op.op === "set") {
    let ref: unknown;
    if (!tokens.length) ref = doc;
    else {
      const parent = getAt(doc, tokens.slice(0, -1));
      const key = tokens[tokens.length - 1] ?? "";
      if (Array.isArray(parent)) ref = (/^(0|[1-9]\d*)$/.test(key) ? parent[Number(key)] : undefined) ?? parent[0];
      else if (isRecord(parent)) ref = hasOwn(parent, key) ? parent[key] : undefined;
    }
    return valueProblem(op.value, ref, keyOf(tokens), op.path, enums);
  }
  if (op.op === "insert") {
    const list = getAt(doc, tokens);
    if (!Array.isArray(list)) return null; // applyOne says why
    return valueProblem(op.value, list[op.index] ?? list[0], keyOf(tokens), `${op.path}/${op.index}`, enums);
  }
  return null;
}

/** the key a value sits under (the last token that is not a list index): "status" for /items/0/status, "tags" for /tags/2 */
function keyOf(tokens: string[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i] ?? "";
    if (!/^(0|[1-9]\d*|-)$/.test(t)) return t;
  }
  return null;
}

/** node by node: the value against the value it replaces (ref); lists item by item (the same index, else the first) */
function valueProblem(value: unknown, ref: unknown, key: string | null, path: string, enums: Map<string, Set<string>>): string | null {
  if (ref === undefined || ref === null || value === null || value === undefined) return null;
  const kind = kindOf(value);
  const want = kindOf(ref);
  if (kind !== want) return `${where(path)}: ${want} expected, got ${kind}`;
  if (Array.isArray(value)) {
    const items = ref as unknown[];
    for (const [i, item] of value.entries()) {
      const p = valueProblem(item, items[i] ?? items[0], key, `${path}/${i}`, enums);
      if (p) return p;
    }
    return null;
  }
  if (isRecord(value)) {
    const r = ref as Record<string, unknown>;
    for (const k of Object.keys(value)) {
      const p = valueProblem(value[k], hasOwn(r, k) ? r[k] : undefined, k, `${path}/${escapeToken(k)}`, enums);
      if (p) return p;
    }
    return null;
  }
  if (typeof value === "string") return stringProblem(value, ref as string, key, path, enums);
  return null;
}

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const ISO_TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** codes: airport NRT, seat A12, flight ANA123, a price as a string "1200", "12.50", "AB-12" */
const CODE = /^[A-Z0-9]+(?:[-_.:/][A-Z0-9]+)*$/;
const UPPER_ENUM = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const LOWER_ENUM = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const ENUM_KEY = /(?:^|[_-]|[a-z])(?:status|state|type|kind|mode|level|role|tier)$/i;
const FREE_TEXT_KEY = /(name|title|text|label|comment|description|desc|message|body|note|notes|caption|summary|content|alt|heading|subtitle|html|markdown)$/i;

function isoKind(s: string): string | null {
  if (ISO_DATE.test(s)) return "date";
  if (ISO_DATE_TIME.test(s) && !Number.isNaN(Date.parse(s.replace(" ", "T")))) return "date-time";
  if (ISO_TIME.test(s)) return "time";
  if (ISO_MONTH.test(s)) return "year-month";
  return null;
}

/** letters, digits and separators: "ANA123" -> "A9", "A-12" -> "A-9" */
const shapeOf = (s: string) => s.replace(/[A-Z]+/g, "A").replace(/[0-9]+/g, "9").replace(/[a-z]+/g, "a");

const isEnumLike = (ref: string, key: string | null) =>
  UPPER_ENUM.test(ref) || LOWER_ENUM.test(ref) || (!!key && ENUM_KEY.test(key) && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(ref));

function stringProblem(value: string, ref: string, key: string | null, path: string, enums: Map<string, Set<string>>): string | null {
  if (value === ref) return null;
  const iso = isoKind(ref);
  if (iso) return isoKind(value) === iso ? null : `${where(path)}: an ISO ${iso} expected (like ${JSON.stringify(ref)}), got ${JSON.stringify(value)}`;
  if (key && FREE_TEXT_KEY.test(key)) return null;
  if (isEnumLike(ref, key)) {
    const seen = (key && enums.get(key)) || new Set([ref]);
    if (seen.has(value)) return null;
    const list = [...seen].slice(0, 12).map((v) => JSON.stringify(v)).join(", ");
    return `${where(path)}: one of ${list} expected (the values of ${key ? `"${key}"` : "this key"} in the recorded body), got ${JSON.stringify(value)}`;
  }
  if (ref.length <= 40 && CODE.test(ref) && shapeOf(value) !== shapeOf(ref)) {
    return `${where(path)}: a code like ${JSON.stringify(ref)} expected (same pattern of capitals and digits), got ${JSON.stringify(value)}`;
  }
  return null;
}

/** the string values of each key in the recorded body (list items count for the key of the list) */
function enumValues(recorded: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (k: string, v: string) => {
    let set = out.get(k);
    if (!set) out.set(k, (set = new Set()));
    set.add(v);
  };
  const walk = (v: unknown, key: string | null) => {
    if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (isRecord(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === "string" && key !== null) add(key, v);
  };
  walk(recorded, null);
  return out;
}

// ---------------------------------------------------------------- distinct list items

/** equal records in a list (objects only): items - distinct items */
function duplicatesIn(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  const records = list.filter(isRecord).map(canonical);
  return records.length - new Set(records).size;
}

/** the first list that has more equal records than the recorded list at the same place, with a pair of them */
function newDuplicate(recorded: unknown, doc: unknown): { pointer: string; i: number; j: number } | null {
  const walk = (v: unknown, tokens: string[]): { pointer: string; i: number; j: number } | null => {
    if (Array.isArray(v)) {
      if (duplicatesIn(v) > duplicatesIn(getAt(recorded, tokens))) {
        const seen = new Map<string, number>();
        for (const [j, item] of v.entries()) {
          if (!isRecord(item)) continue;
          const c = canonical(item);
          const i = seen.get(c);
          if (i !== undefined) return { pointer: tokens.map((t) => `/${escapeToken(t)}`).join(""), i, j };
          seen.set(c, j);
        }
      }
      for (const [i, item] of v.entries()) {
        const found = walk(item, [...tokens, String(i)]);
        if (found) return found;
      }
    } else if (isRecord(v)) {
      for (const [k, item] of Object.entries(v)) {
        const found = walk(item, [...tokens, k]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(doc, []);
}

/** the applied op after which the list at pointer last got more equal records (the one that made the duplicate) */
function lastIncrease(recorded: unknown, ops: MockOp[], applied: number[], pointer: string): number | null {
  const tokens = parsePointer(pointer);
  let doc = clone(recorded);
  let before = duplicatesIn(getAt(doc, tokens));
  let culprit: number | null = null;
  for (const i of applied) {
    doc = applyOne(doc, ops[i] as MockOp);
    const now = duplicatesIn(getAt(doc, tokens));
    if (now > before) culprit = i;
    before = now;
  }
  return culprit;
}
