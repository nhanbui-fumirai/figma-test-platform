/** Internal: the JSON of a model answer (fenced or raw) and short descriptions of what is wrong with it. */
import type { z } from "zod";

export type Extracted = { ok: true; value: unknown } | { ok: false; reason: string };

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

/**
 * The JSON value of an answer: the first ```json fenced block that parses (then any other fenced block), else the whole
 * answer, else the first balanced {...} or [...] in it.
 */
export function extractJson(answer: string): Extracted {
  const text = answer.trim();
  if (!text) return { ok: false, reason: "the answer is empty" };

  const fenced: { lang: string; body: string }[] = [];
  for (const m of text.matchAll(FENCE)) fenced.push({ lang: (m[1] ?? "").toLowerCase(), body: m[2] ?? "" });
  fenced.sort((a, b) => rank(a.lang) - rank(b.lang));
  let firstError = "";
  for (const f of fenced) {
    const r = tryParse(f.body);
    if (r.ok) return r;
    firstError ||= `the fenced block is not valid JSON (${r.reason})`;
  }

  const whole = tryParse(text);
  if (whole.ok) return whole;

  const slice = balancedSlice(text);
  if (slice !== null) {
    const r = tryParse(slice);
    if (r.ok) return r;
    firstError ||= `not valid JSON (${r.reason})`;
  } else if (/[[{]/.test(text)) {
    firstError ||= "the JSON is incomplete (cut off before its end?)";
  }
  return { ok: false, reason: firstError || "no JSON in the answer" };
}

const rank = (lang: string) => (lang === "json" || lang === "jsonc" ? 0 : lang === "" ? 1 : 2);

function tryParse(s: string): Extracted {
  try {
    return { ok: true, value: JSON.parse(s.trim()) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 200) };
  }
}

/** The first {...} or [...] of the text with its brackets balanced (strings respected), or null. */
function balancedSlice(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** "steps[0].target: a target needs testId, role, label, placeholder, text or css; ..." (first issues only). */
export function describeIssues(error: z.ZodError, max = 6): string {
  const lines = error.issues.slice(0, max).map((issue) => `${formatPath(issue.path)}: ${issueMessage(issue)}`);
  if (error.issues.length > max) lines.push(`(${error.issues.length - max} more problems)`);
  return lines.join("; ");
}

function issueMessage(issue: z.core.$ZodIssue): string {
  // a discriminated union with an unknown tag: say which tags exist
  if (issue.code === "invalid_union" && "note" in issue && issue.note === "No matching discriminator") {
    const values = (issue as { options?: unknown[] }).options;
    const key = (issue as { discriminator?: string }).discriminator;
    if (key && Array.isArray(values)) return `"${key}" must be one of ${values.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return issue.message;
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : `${out ? "." : ""}${String(p)}`;
  return out || "(root)";
}
