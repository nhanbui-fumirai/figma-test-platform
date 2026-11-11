"use client";

/**
 * Editor of the steps DSL of a screen (contracts Step / Target). Rows are drafts with string fields; toStep turns them
 * into steps, then the Steps schema validates them before saving.
 */
import { Steps, type Step, type Target } from "@figtest/contracts";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "@/components/icons";
import { Button, Checkbox, Input, Select } from "@/components/ui";

export const ACTIONS: Step["action"][] = ["goto", "click", "fill", "select", "check", "press", "hover", "scroll", "waitFor", "wait"];
type Action = Step["action"];

/** how a step finds its element: the first set field wins, in this order */
const KINDS = ["testId", "role", "label", "placeholder", "text", "css"] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = { testId: "test id", role: "role", label: "label", placeholder: "placeholder", text: "text", css: "css" };

const TARGET: Record<Action, "required" | "optional" | "none"> = {
  goto: "none", click: "required", fill: "required", select: "required", check: "required", press: "optional",
  hover: "required", scroll: "optional", waitFor: "required", wait: "none",
};

export type TargetDraft = { kind: Kind | "none"; value: string; name: string; exact: boolean; nth: string };
export type StepDraft = {
  uid: number; action: Action; url: string; target: TargetDraft; value: string; key: string; ms: string; y: string; checked: boolean;
  state: "visible" | "hidden";
};

let uids = 0;
const nextUid = () => ++uids;

export function blankStep(action: Action = "click"): StepDraft {
  return {
    uid: nextUid(), action, url: "", value: "", key: "", ms: "1000", y: "", checked: true, state: "visible",
    target: { kind: TARGET[action] === "required" ? "text" : "none", value: "", name: "", exact: false, nth: "" },
  };
}

function targetFrom(t: Target | undefined): TargetDraft {
  const kind = t ? KINDS.find((k) => t[k]) : undefined;
  if (!t || !kind) return { kind: "none", value: "", name: "", exact: false, nth: "" };
  return { kind, value: t[kind] ?? "", name: t.name ?? "", exact: !!t.exact, nth: t.nth === undefined ? "" : String(t.nth) };
}

function targetTo(d: TargetDraft): Target | undefined {
  if (d.kind === "none") return undefined;
  const t: Target = {};
  t[d.kind] = d.value.trim();
  if (d.kind === "role" && d.name.trim()) t.name = d.name.trim();
  if (d.exact && d.kind !== "testId" && d.kind !== "css") t.exact = true;
  if (d.nth.trim() !== "") t.nth = Number(d.nth);
  return t;
}

export function fromStep(s: Step): StepDraft {
  const d = blankStep(s.action);
  if ("target" in s) d.target = targetFrom(s.target);
  if (s.action === "goto") d.url = s.url;
  if (s.action === "fill" || s.action === "select") d.value = s.value;
  if (s.action === "check") d.checked = s.checked;
  if (s.action === "press") d.key = s.key;
  if (s.action === "scroll" && s.y !== undefined) d.y = String(s.y);
  if (s.action === "waitFor") d.state = s.state;
  if (s.action === "wait") d.ms = String(s.ms);
  return d;
}

/** the step of a draft, unchecked (Steps validates it) */
function toStep(d: StepDraft): unknown {
  const target = targetTo(d.target);
  // a required target left empty: {} so that the schema says what a target needs
  const req = target ?? {};
  switch (d.action) {
    case "goto": return { action: "goto", url: d.url.trim() };
    case "click": case "hover": return { action: d.action, target: req };
    case "fill": case "select": return { action: d.action, target: req, value: d.value };
    case "check": return { action: "check", target: req, checked: d.checked };
    case "press": return { action: "press", key: d.key.trim(), ...(target ? { target } : {}) };
    case "scroll": return { action: "scroll", ...(target ? { target } : {}), ...(d.y.trim() ? { y: Number(d.y) } : {}) };
    case "waitFor": return { action: "waitFor", target: req, state: d.state };
    case "wait": return { action: "wait", ms: d.ms.trim() === "" ? Number.NaN : Number(d.ms) };
  }
}

/** the steps of the drafts, or the problems of each step ("Step 2 · target: …") */
export function validateSteps(drafts: StepDraft[]): { ok: true; steps: Step[] } | { ok: false; errors: string[] } {
  const parsed = Steps.safeParse(drafts.map(toStep));
  if (parsed.success) return { ok: true, steps: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => {
      const [index, ...rest] = i.path;
      const where = typeof index === "number" ? `Step ${index + 1}${rest.length ? ` · ${rest.map(String).join(".")}` : ""}` : "Steps";
      return `${where}: ${i.message}`;
    }),
  };
}

export function StepsEditor({ steps, onChange }: { steps: StepDraft[]; onChange: (s: StepDraft[]) => void }) {
  const set = (i: number, patch: Partial<StepDraft>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setTarget = (i: number, patch: Partial<TargetDraft>) => set(i, { target: { ...steps[i]!.target, ...patch } });
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {steps.length === 0 && <p className="text-xs text-muted">No step: the page is compared as it opens.</p>}
      {steps.map((s, i) => {
        const targetMode = TARGET[s.action];
        return (
          <div key={s.uid} className="flex flex-col gap-2 rounded-md border border-line bg-bg/50 p-2">
            <div className="flex items-center gap-2">
              <span className="w-5 text-right text-xs text-muted tabular-nums">{i + 1}</span>
              <Select
                value={s.action} aria-label="Action"
                onChange={(e) => {
                  const action = e.target.value as Action;
                  const target = TARGET[action] === "required" && s.target.kind === "none" ? { ...s.target, kind: "text" as const } : s.target;
                  set(i, { action, target });
                }}
              >
                {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </Select>
              {s.action === "goto" && <Input value={s.url} onChange={(e) => set(i, { url: e.target.value })} placeholder="/path or https://same-host/…" />}
              {s.action === "press" && <Input className="w-40" value={s.key} onChange={(e) => set(i, { key: e.target.value })} placeholder="Enter, Escape, Tab…" />}
              {s.action === "wait" && (
                <><Input className="w-28" type="number" min={0} max={30000} value={s.ms} onChange={(e) => set(i, { ms: e.target.value })} /><span className="text-xs text-muted">ms</span></>
              )}
              <div className="ml-auto flex shrink-0 items-center">
                <Button variant="subtle" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUpIcon width={14} /></Button>
                <Button variant="subtle" size="sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down"><ArrowDownIcon width={14} /></Button>
                <Button variant="subtle" size="sm" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label="Remove"><XIcon width={14} /></Button>
              </div>
            </div>

            {targetMode !== "none" && (
              <div className="flex flex-wrap items-center gap-2 pl-7">
                <Select value={s.target.kind} onChange={(e) => setTarget(i, { kind: e.target.value as TargetDraft["kind"] })} aria-label="Find by">
                  {targetMode === "optional" && <option value="none">no target</option>}
                  {KINDS.map((k) => <option key={k} value={k}>by {KIND_LABEL[k]}</option>)}
                </Select>
                {s.target.kind !== "none" && (
                  <>
                    <Input
                      className="min-w-40 flex-1" value={s.target.value} onChange={(e) => setTarget(i, { value: e.target.value })}
                      placeholder={s.target.kind === "role" ? "button, link, tab, checkbox…" : s.target.kind === "css" ? ".menu > li:first-child" : KIND_LABEL[s.target.kind]}
                    />
                    {s.target.kind === "role" && (
                      <Input className="min-w-32 flex-1" value={s.target.name} onChange={(e) => setTarget(i, { name: e.target.value })} placeholder="accessible name" />
                    )}
                    {s.target.kind !== "testId" && s.target.kind !== "css" && (
                      <Checkbox label={<span className="text-xs">exact</span>} checked={s.target.exact} onChange={(e) => setTarget(i, { exact: e.target.checked })} />
                    )}
                    <Input className="w-20" type="number" min={0} value={s.target.nth} onChange={(e) => setTarget(i, { nth: e.target.value })} placeholder="nth" title="which match (0 = first)" />
                  </>
                )}
              </div>
            )}

            {(s.action === "fill" || s.action === "select") && (
              <div className="pl-7">
                <Input value={s.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={s.action === "fill" ? "text to type" : "option value or label"} />
              </div>
            )}
            {s.action === "check" && (
              <div className="pl-7"><Checkbox label="checked" checked={s.checked} onChange={(e) => set(i, { checked: e.target.checked })} /></div>
            )}
            {s.action === "scroll" && (
              <div className="flex items-center gap-2 pl-7">
                <Input className="w-32" type="number" min={0} value={s.y} onChange={(e) => set(i, { y: e.target.value })} placeholder="y (px)" />
                <span className="text-xs text-muted">scrolls the target into view, or the page to y</span>
              </div>
            )}
            {s.action === "waitFor" && (
              <div className="pl-7">
                <Select value={s.state} onChange={(e) => set(i, { state: e.target.value as StepDraft["state"] })} aria-label="State">
                  <option value="visible">until visible</option>
                  <option value="hidden">until hidden</option>
                </Select>
              </div>
            )}
          </div>
        );
      })}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange([...steps, blankStep()])} disabled={steps.length >= 100}>Add a step</Button>
    </div>
  );
}
