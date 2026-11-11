import { Step } from "@figtest/contracts";
import { z } from "zod";
import { completeJson } from "./client";
import type { AiConfig, AiContent, OnUsage, StepsInput, StepsOutput } from "./types";

/** At most this many steps per round: the page is looked at again after they run. */
export const MAX_STEPS_PER_ROUND = 10;
const MAX_ARIA_CHARS = 24_000;
const MAX_DESIGN_TEXTS = 200;
const MAX_HISTORY = 30;

const STEPS_SYSTEM = `You bring a web page, one round at a time, to the state shown by its Figma design (a menu open, a tab chosen, a form filled, a dialog shown...). Each round you get the goal, the texts and the image of the design, the page as it is now (its URL and accessibility tree) and the steps already run with their outcome. You answer the next few steps, or that the page is done.

Steps are a small JSON language, never code. Each step is one of:
- {"action":"click","target":T}
- {"action":"fill","target":T,"value":"the text typed"}   (an empty value empties the field)
- {"action":"select","target":T,"value":"option value or label"}
- {"action":"check","target":T,"checked":true}   (false unchecks)
- {"action":"press","key":"Enter"}   (Enter, Tab, Escape, ArrowDown...; add "target":T to press it in an element)
- {"action":"hover","target":T}
- {"action":"scroll","target":T}   (into view; or {"action":"scroll","y":1200} for the page)
- {"action":"waitFor","target":T,"state":"visible"}   ("hidden" waits until it goes)
- {"action":"wait","ms":500}   (only when the page animates; at most 2000 in practice)
- {"action":"goto","url":"/path"}   (only when the goal needs another page of the same site)

A target T finds one element, like a Playwright locator. Prefer, in this order:
1. {"testId":"..."} when the page shows a data-testid for it
2. {"role":"button","name":"Accessible name"}: role and name exactly as in the accessibility tree (add "exact":true when another element's name contains this one)
3. {"label":"text of the field's label"}
4. {"placeholder":"..."}
5. {"text":"visible text"}
6. {"css":"..."} only as a last resort: short and stable, never generated class names
Add "nth": i (0-based) only when several elements still match.

Rules:
- Only steps that bring the page closer to the design and the goal. Few steps per round (1 to 5): you see the page again after they run.
- Names and texts exactly as the PAGE shows them (the design may show other sample texts).
- Never repeat a step that failed with the same target: use another target or another way.
- No checks, no steps for what the page already shows.
- "done": true only when the page already is in the state of the design (or nothing more can bring it closer); then "steps" is [].
- "note": one short sentence (what the steps do, or why it is done).

Answer: {"steps":[...],"done":false,"note":"..."}`;

const StepsAnswer = z
  .preprocess(
    // a bare list of steps is accepted as { steps }
    (v) => (Array.isArray(v) ? { steps: v, done: v.length === 0 } : v),
    z.object({
      steps: z.array(Step).max(MAX_STEPS_PER_ROUND),
      done: z.boolean().default(false),
      note: z.string().nullish().transform((n) => (n ?? "").slice(0, 1000)),
    }),
  )
  .superRefine((a, ctx) => {
    if (!a.done && a.steps.length === 0) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: 'no steps and not done: give the next steps, or "done": true' });
    }
  });

/** One round of the steps loop: given the page now, the next steps (validated Step objects) or done. */
export async function nextSteps(cfg: AiConfig, input: StepsInput, onUsage?: OnUsage, opts: { signal?: AbortSignal } = {}): Promise<StepsOutput> {
  const content: AiContent = [];
  if (input.designImage) content.push({ type: "image", png: input.designImage });
  content.push({ type: "text", text: stepsPrompt(input) });
  const answer = await completeJson(
    cfg,
    { system: STEPS_SYSTEM, content, schema: StepsAnswer, maxTokens: 16_000, signal: opts.signal, purpose: "steps" },
    onUsage,
  );
  // steps to run first: the page is done only once they ran (the next round says so with no steps)
  const done = answer.done && answer.steps.length === 0;
  return { steps: answer.steps, done, note: answer.note };
}

/** The user turn of a round (exported for tests). */
export function stepsPrompt(input: StepsInput): string {
  const texts = input.designTexts
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_DESIGN_TEXTS)
    .map((t) => `- ${JSON.stringify(t.length > 150 ? `${t.slice(0, 150)}…` : t)}`);
  const more = input.designTexts.length > MAX_DESIGN_TEXTS ? `\n(${input.designTexts.length - MAX_DESIGN_TEXTS} more texts)` : "";
  const aria = input.ariaSnapshot.length > MAX_ARIA_CHARS
    ? `${input.ariaSnapshot.slice(0, MAX_ARIA_CHARS)}\n…(cut: ${input.ariaSnapshot.length - MAX_ARIA_CHARS} more characters)`
    : input.ariaSnapshot;
  const skipped = Math.max(0, input.history.length - MAX_HISTORY);
  const history = input.history.slice(skipped).map((h, i) => {
    const n = skipped + i + 1;
    const outcome = h.ok ? "ok" : `FAILED: ${(h.error ?? "error").replace(/\s+/g, " ").trim().slice(0, 300)}`;
    return `${n}. ${JSON.stringify(h.step)} → ${outcome}`;
  });
  return [
    "## Goal",
    input.goal.trim() || "Bring the page to the state of the design.",
    "",
    `## Texts of the design, in reading order${input.designImage ? " (the image above is the design)" : ""}`,
    texts.length ? texts.join("\n") + more : "(none)",
    "",
    "## The page now",
    `URL: ${input.url}`,
    "Accessibility tree:",
    aria.trim() || "(empty)",
    "",
    "## Steps already run, oldest first",
    history.length ? (skipped ? `(${skipped} earlier steps not shown)\n` : "") + history.join("\n") : "(none yet)",
  ].join("\n");
}
