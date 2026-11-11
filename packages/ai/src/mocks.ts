import { MockOp } from "@figtest/contracts";
import { z } from "zod";
import { bodyView, checkOps } from "./body";
import { completeJson } from "./client";
import type { AiConfig, AiContent, MockOpsInput, MockOpsOutput, OnUsage } from "./types";

const MAX_DESIGN_TEXTS = 300;
const MAX_VIEW_CHARS = 40_000;

const MOCK_SYSTEM = `You edit the recorded answer (a JSON body) of one API call of a web page, so that the page shows the data of its Figma design: the texts the design shows and the number of items of its lists. You do not rewrite the body: you answer edit operations (ops) on it. The served body = the recorded body + your ops, applied in order.

Ops. Paths are JSON Pointers (RFC 6901) into the REAL recorded body: "" is the whole body, "/data/items/0/name" a field; in a key, "/" is written "~1" and "~" is written "~0".
- {"op":"set","path":P,"value":V}   replaces the value at P (or adds a key to an object)
- {"op":"remove","path":P}   removes a key, or an item of a list
- {"op":"insert","path":P,"index":i,"value":V}   inserts V into the list at P before item i (i = the length appends)
- {"op":"duplicate","path":P,"index":i,"count":n}   copies item i of the list at P n times, right after it
An op sees the body as the ops before it left it: indexes shift after insert, duplicate and remove.

The body you are shown is trimmed: a list longer than a few items shows its first items, then a marker string "…N more items (the list has L)" that is NOT in the body; long strings end with "…(+N chars)". The real lengths of the lists are listed. Paths address the real body: item 10 of a list of 50 is "/items/10" even when the view does not show it.

Rules:
- Keep the kind of every value: the app parses and formats it. Numbers stay numbers ("¥42,300" is 42300, "4.5 ★" is 4.5, "61 results" is 61), booleans stay booleans, ISO dates stay ISO dates (2026-05-25T16:00:00Z, not "May 25"), codes keep their pattern (an airport "HND", an enum "NO_SMOKING", an id "A12" becomes another code like "A13"), never their display label. A display text in a number, date or code field breaks the page.
- Set the texts the design shows, in the fields that hold them. Keep the other values (ids, slugs, image URLs, links) unless the design shows them.
- Each list shows as many items as the design: use duplicate (from an item like the ones needed) or insert (a complete item with every key of the other items, same kinds) to add items, then set their values; remove extra items from the end. Update the counts of the body (total, count) to match.
- Items of a list stay distinct records: when you add items, give each one its own id-like values (id 12 → 13, 14; "A12" → "A13") and the values the design shows; when the design repeats one sample item, keep the copies but make each one differ a little in what identifies it.
- Only ops that change something; when most fields of an item change, set the whole item in one op.
- Texts the API cannot give (labels and menus written in the app): no op; mention them in the note.
- "note": one short sentence (what changed, what could not).

Answer: {"ops":[...],"note":"..."}`;

/** Ops that make a recorded body show the data of the design (texts, number of items), keeping value kinds. */
export async function mockOps(cfg: AiConfig, input: MockOpsInput, onUsage?: OnUsage, opts: { signal?: AbortSignal } = {}): Promise<MockOpsOutput> {
  const schema = z
    .preprocess(
      // a bare list of ops is accepted as { ops }
      (v) => (Array.isArray(v) ? { ops: v } : v),
      z.object({
        ops: z.array(MockOp).max(500),
        note: z.string().nullish().transform((n) => (n ?? "").slice(0, 1000)),
      }),
    )
    .superRefine((a, ctx) => {
      // every path must address the real body (ops dry-run in order)
      for (const problem of checkOps(input.body, a.ops)) ctx.addIssue({ code: "custom", path: ["ops"], message: problem });
    });

  const content: AiContent = [];
  if (input.designImage) content.push({ type: "image", png: input.designImage });
  content.push({ type: "text", text: mockPrompt(input) });
  const answer = await completeJson(
    cfg,
    { system: MOCK_SYSTEM, content, schema, maxTokens: 32_000, signal: opts.signal, purpose: "mock-ops" },
    onUsage,
  );
  return { ops: answer.ops, note: answer.note };
}

/** The user turn (exported for tests). */
export function mockPrompt(input: MockOpsInput): string {
  const { route } = input;
  const view = bodyView(input.body, MAX_VIEW_CHARS);
  const texts = input.designTexts
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_DESIGN_TEXTS)
    .map((t) => `- ${JSON.stringify(t.length > 200 ? `${t.slice(0, 200)}…` : t)}`);
  const more = input.designTexts.length > MAX_DESIGN_TEXTS ? `\n(${input.designTexts.length - MAX_DESIGN_TEXTS} more texts)` : "";
  return [
    "## API call",
    `${route.method.toUpperCase()} ${route.path}${route.operationName ? `  (GraphQL operation ${route.operationName})` : ""}`,
    "",
    `## Texts of the design, in reading order${input.designImage ? " (the image above is the design)" : ""}`,
    texts.length ? texts.join("\n") + more : "(none)",
    "",
    "## Lists of the recorded body, with their real lengths",
    view.lists.length ? view.lists.join("\n") : "(no list)",
    "",
    `## Recorded body (trimmed view: lists show their first ${view.opts.items} item${view.opts.items === 1 ? "" : "s"})`,
    "```json",
    view.json,
    "```",
  ].join("\n");
}
