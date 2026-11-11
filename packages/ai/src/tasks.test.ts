import type { MockOp } from "@figtest/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyView, checkOps, listLengths, trimBody } from "./body";
import { AiError } from "./client";
import { mockOps, mockPrompt } from "./mocks";
import { nextSteps, stepsPrompt } from "./steps";
import { setTestHooks } from "./transport";
import type { AiConfig, AiUsage, MockOpsInput, StepsInput } from "./types";

const CFG: AiConfig = { provider: "openrouter", apiKey: "sk-test-key-xyz", model: "anthropic/claude-opus-5.5" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

function reply(content: string): Response {
  const body = { model: CFG.model, choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } };
  return new Response(JSON.stringify(body), { status: 200 });
}

let calls: any[];
let usages: AiUsage[];
function answers(...contents: string[]) {
  const queue = contents.map(reply);
  setTestHooks({
    fetch: (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      const r = queue.shift();
      if (!r) throw new Error("test: no more fake replies");
      return r;
    }) as typeof fetch,
    sleep: async () => {},
  });
}
const userText = (call: any): string => call.messages[1].content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

beforeEach(() => {
  calls = [];
  usages = [];
  vi.stubGlobal("fetch", () => {
    throw new Error("test: real network call");
  });
});
afterEach(() => {
  setTestHooks({});
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- steps

const STEPS_INPUT: StepsInput = {
  goal: "Open the account menu",
  designTexts: ["My account", "Orders", "Sign out"],
  designImage: PNG,
  url: "https://shop.example/home",
  ariaSnapshot: '- banner:\n  - button "Account"\n  - link "Cart"',
  history: [
    { step: { action: "click", target: { text: "Menu" } }, ok: false, error: "Timeout 5000ms exceeded waiting for getByText('Menu')" },
    { step: { action: "scroll", y: 0 }, ok: true },
  ],
};

describe("nextSteps", () => {
  it("prompts with goal, design, page and history; returns validated steps", async () => {
    answers('```json\n{"steps":[{"action":"click","target":{"role":"button","name":"Account"}}],"done":false,"note":"opens the menu"}\n```');
    const out = await nextSteps(CFG, STEPS_INPUT, (u) => void usages.push(u));
    expect(out).toEqual({ steps: [{ action: "click", target: { role: "button", name: "Account" } }], done: false, note: "opens the menu" });
    const text = userText(calls[0]);
    expect(text).toContain("Open the account menu");
    expect(text).toContain('- "Sign out"');
    expect(text).toContain("URL: https://shop.example/home");
    expect(text).toContain('button "Account"');
    expect(text).toContain('1. {"action":"click","target":{"text":"Menu"}} → FAILED: Timeout 5000ms exceeded');
    expect(text).toContain('2. {"action":"scroll","y":0} → ok');
    expect(calls[0].messages[1].content[0].type).toBe("image_url");
    expect(calls[0].messages[0].content).toMatch(/testId[\s\S]*role[\s\S]*label/);
    expect(usages).toHaveLength(1);
    expect(usages[0]!.purpose).toBe("steps");
  });

  it("rejects what is not the steps DSL (code, unknown actions, empty targets) and fails after 2 repairs", async () => {
    const code = '{"steps":[{"action":"evaluate","code":"document.querySelector(\'#menu\').click()"}],"done":false}';
    answers(code, '{"steps":[{"action":"click","target":{}}],"done":false}', code);
    const e = await nextSteps(CFG, STEPS_INPUT).catch((x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect((e as AiError).code).toBe("invalid_answer");
    expect(calls).toHaveLength(3);
    const firstRepair = userText(calls[1]);
    expect(firstRepair).toMatch(/steps\[0\]\.action: "action" must be one of "goto", "click"/);
    expect(userText(calls[2])).toMatch(/a target needs testId, role, label, placeholder, text or css/);
  });

  it("accepts a corrected answer, and strips keys outside the DSL", async () => {
    answers('[{"action":"run","script":"x"}]', '{"steps":[{"action":"press","key":"Escape","script":"alert(1)"}],"done":false,"note":null}');
    const out = await nextSteps(CFG, STEPS_INPUT);
    expect(out).toEqual({ steps: [{ action: "press", key: "Escape" }], done: false, note: "" });
  });

  it("done: no steps; steps given with done run first", async () => {
    answers('{"steps":[],"done":true,"note":"the menu is open"}');
    expect(await nextSteps(CFG, STEPS_INPUT)).toEqual({ steps: [], done: true, note: "the menu is open" });
    answers('{"steps":[{"action":"hover","target":{"testId":"account"}}],"done":true,"note":"last step"}');
    expect((await nextSteps(CFG, STEPS_INPUT)).done).toBe(false);
  });

  it("asks again when the answer is neither steps nor done", async () => {
    answers('{"steps":[],"done":false}', '{"steps":[],"done":true}');
    expect((await nextSteps(CFG, STEPS_INPUT)).done).toBe(true);
    expect(userText(calls[1])).toContain("no steps and not done");
  });

  it("cuts a huge accessibility tree and keeps the latest history", () => {
    const text = stepsPrompt({ ...STEPS_INPUT, ariaSnapshot: "x".repeat(30_000), history: Array.from({ length: 35 }, (_, i) => ({ step: { action: "wait", ms: i }, ok: true })) });
    expect(text).toMatch(/…\(cut: 6000 more characters\)/);
    expect(text).toContain("(5 earlier steps not shown)");
    expect(text).toContain('35. {"action":"wait","ms":34} → ok');
    expect(text).not.toContain('5. {"action":"wait","ms":4}');
  });
});

// ---------------------------------------------------------------- mock body view and ops

const BODY = {
  data: {
    total: 50,
    items: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, description: "d".repeat(500), tags: ["a", "b"], "a/b~c": i })),
  },
  updatedAt: "2026-05-25T16:00:00Z",
};

describe("body view", () => {
  it("trims lists and long strings but keeps the real indexes and lengths", () => {
    const view = trimBody(BODY) as any;
    expect(view.data.items).toHaveLength(4);
    expect(view.data.items[2].name).toBe("Product 3");
    expect(view.data.items[3]).toBe("…47 more items (the list has 50)");
    expect(view.data.items[0].description).toBe(`${"d".repeat(200)}…(+300 chars)`);
    expect(BODY.data.items).toHaveLength(50);
    expect(listLengths(BODY)).toEqual(["/data/items: 50 items", "/data/items/0/tags: 2 items", "/data/items/1/tags: 2 items", "/data/items/2/tags: 2 items"]);
  });

  it("shrinks the view of a very large body", () => {
    const row = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, "x".repeat(150)]));
    const big = { rows: Array.from({ length: 5 }, () => row) };
    const v = bodyView(big, 8_000);
    expect(v.json.length).toBeLessThanOrEqual(8_000 + 60);
    expect(v.opts.items).toBeLessThan(3);
  });

  it("checks ops on the real body: items not shown in the view are addressable, wrong paths are reported", () => {
    const ok: MockOp[] = [
      { op: "set", path: "/data/items/40/name", value: "Asgaard sofa" },
      { op: "duplicate", path: "/data/items", index: 2, count: 3 },
      { op: "set", path: "/data/items/52/id", value: 999 },
      { op: "insert", path: "/data/items", index: 53, value: { id: 1000, name: "New" } },
      { op: "set", path: "/data/items/0/a~1b~0c", value: 5 },
      { op: "remove", path: "/updatedAt" },
      { op: "set", path: "/data/newKey", value: true },
    ];
    expect(checkOps(BODY, ok)).toEqual([]);
    const bad: MockOp[] = [
      { op: "set", path: "/data/items/60/name", value: "x" },
      { op: "insert", path: "/data/total", index: 0, value: 1 },
      { op: "set", path: "data/items", value: [] },
      { op: "duplicate", path: "/data/items", index: 50, count: 1 },
      { op: "remove", path: "/data/nothing" },
      { op: "set", path: "/data/items/x/name", value: 1 },
      { op: "set", path: "/data/items/1/name" } as MockOp,
    ];
    const problems = checkOps(BODY, bad);
    expect(problems).toEqual([
      'ops[0] (set "/data/items/60/name"): /data/items/60 does not exist (the list has 50 items)',
      'ops[1] (insert "/data/total"): insert needs a list, /data/total is number',
      'ops[2] (set "data/items"): a JSON Pointer starts with "/" ("" is the whole body)',
      'ops[3] (duplicate "/data/items"): item 50 does not exist (the list has 50 items)',
      'ops[4] (remove "/data/nothing"): /data/nothing does not exist',
      'ops[5] (set "/data/items/x/name"): "x" is not an index of the list at /data/items',
      'ops[6] (set "/data/items/1/name"): set needs a value',
    ]);
  });
});

describe("mockOps", () => {
  const INPUT: MockOpsInput = {
    route: { method: "get", path: "/api/products", operationName: null },
    body: BODY,
    designTexts: ["Syltherine", "Rp 2.500.000", "Leviosa"],
    designImage: PNG,
  };

  it("prompts with the trimmed body and the real list lengths; returns valid ops", async () => {
    answers(
      JSON.stringify({
        ops: [
          { op: "remove", path: "/data/items/2" },
          { op: "set", path: "/data/items/0/name", value: "Syltherine" },
          { op: "duplicate", path: "/data/items", index: 0 },
          { op: "set", path: "/data/total", value: 8 },
        ],
        note: "names and counts from the design",
      }),
    );
    const out = await mockOps(CFG, INPUT, (u) => void usages.push(u));
    expect(out.note).toBe("names and counts from the design");
    expect(out.ops).toEqual([
      { op: "remove", path: "/data/items/2" },
      { op: "set", path: "/data/items/0/name", value: "Syltherine" },
      { op: "duplicate", path: "/data/items", index: 0, count: 1 },
      { op: "set", path: "/data/total", value: 8 },
    ]);
    const text = userText(calls[0]);
    expect(text).toContain("GET /api/products");
    expect(text).toContain("/data/items: 50 items");
    expect(text).toContain("…47 more items (the list has 50)");
    expect(text).toContain('"Product 3"');
    expect(text).not.toContain('"Product 4"');
    expect(calls[0].messages[0].content).toMatch(/numbers stay numbers[\s\S]*ISO dates stay ISO[\s\S]*codes keep their pattern/i);
    expect(calls[0].messages[0].content).toMatch(/duplicate[\s\S]*distinct/);
    expect(usages[0]!.purpose).toBe("mock-ops");
  });

  it("sends wrong paths back for repair", async () => {
    answers('{"ops":[{"op":"set","path":"/data/items/60/name","value":"x"}],"note":""}', '[{"op":"set","path":"/data/items/49/name","value":"x"}]');
    const out = await mockOps(CFG, INPUT);
    expect(out.ops).toEqual([{ op: "set", path: "/data/items/49/name", value: "x" }]);
    expect(userText(calls[1])).toContain("/data/items/60 does not exist (the list has 50 items)");
  });

  it("works on a body that is not an object", () => {
    expect(mockPrompt({ ...INPUT, body: "plain text" })).toContain('"plain text"');
    expect(checkOps([1, 2], [{ op: "set", path: "", value: [3] }])).toEqual([]);
  });
});
