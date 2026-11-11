/**
 * Domain shapes shared by the web (editors), the api (validation) and the worker packages (browser, mocks, ai):
 * the state of a screen (cookies, steps), the edits of a mock body (ops), the test login of a project.
 */
import { z } from "zod";

// ---- how a step finds an element: Playwright locators, no code. The first set field wins, in this order:
// testId, role (+ name), label, placeholder, text, css. nth picks one of several matches.
export const Target = z
  .object({
    testId: z.string().max(200).optional(),
    role: z.string().max(40).optional(),
    name: z.string().max(300).optional(),
    exact: z.boolean().optional(),
    label: z.string().max(300).optional(),
    placeholder: z.string().max(300).optional(),
    text: z.string().max(300).optional(),
    css: z.string().max(500).optional(),
    nth: z.number().int().min(0).max(1000).optional(),
  })
  .refine((t) => !!(t.testId || t.role || t.label || t.placeholder || t.text || t.css), {
    message: "a target needs testId, role, label, placeholder, text or css",
  });
export type Target = z.infer<typeof Target>;

/** One action of the steps DSL that brings a page to the state of its design (open a menu, pick a tab ...). */
export const Step = z.discriminatedUnion("action", [
  /** url: absolute (same host as the screen URL) or relative to it */
  z.object({ action: z.literal("goto"), url: z.string().min(1).max(2000) }),
  z.object({ action: z.literal("click"), target: Target }),
  z.object({ action: z.literal("fill"), target: Target, value: z.string().max(2000) }),
  z.object({ action: z.literal("select"), target: Target, value: z.string().max(500) }),
  z.object({ action: z.literal("check"), target: Target, checked: z.boolean().default(true) }),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(40), target: Target.optional() }),
  z.object({ action: z.literal("hover"), target: Target }),
  /** scrolls the target into view, or the page to y */
  z.object({ action: z.literal("scroll"), target: Target.optional(), y: z.number().min(0).max(100000).optional() }),
  z.object({ action: z.literal("waitFor"), target: Target, state: z.enum(["visible", "hidden"]).default("visible") }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(30000) }),
]);
export type Step = z.infer<typeof Step>;
export const Steps = z.array(Step).max(100);

/** A cookie set before the page opens (a cart id, a consent flag). The domain defaults to the host of the URL. */
export const Cookie = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(4000),
  domain: z.string().max(253).optional(),
  path: z.string().max(500).optional(),
});
export type Cookie = z.infer<typeof Cookie>;
export const Cookies = z.array(Cookie).max(50);

/**
 * Test account of a project (kept encrypted, never sent back to the web). The login form is filled on loginUrl,
 * whose host must be the host of the project website: the password is never typed on another site.
 */
export const TestLogin = z.object({
  loginUrl: z.url({ protocol: /^https?$/ }),
  username: z.string().min(1).max(300),
  password: z.string().min(1).max(300),
  usernameSelector: z.string().max(500).optional(),
  passwordSelector: z.string().max(500).optional(),
  submitSelector: z.string().max(500).optional(),
  /** a selector or text that shows the login worked (else: the URL left the login page) */
  successSelector: z.string().max(500).optional(),
});
export type TestLogin = z.infer<typeof TestLogin>;

/**
 * An edit of a recorded mock body, addressed by JSON Pointer (RFC 6901, "/data/flights/0/price"). The recorded body
 * stays as it was recorded; the served body = recorded body + ops, so an edit can be undone and re-checked.
 */
export const MockOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string().max(1000), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string().max(1000) }),
  /** inserts value into the array at path, before index (index = length appends) */
  z.object({ op: z.literal("insert"), path: z.string().max(1000), index: z.number().int().min(0), value: z.unknown() }),
  /** copies the item at index of the array at path, count times, right after it */
  z.object({ op: z.literal("duplicate"), path: z.string().max(1000), index: z.number().int().min(0), count: z.number().int().min(1).max(100).default(1) }),
]);
export type MockOp = z.infer<typeof MockOp>;
export const MockOps = z.array(MockOp).max(500);

/** AI provider settings of a project (the key itself is a credential). */
export const AiSettings = z.object({
  provider: z.enum(["anthropic", "openrouter"]),
  model: z.string().min(1).max(200),
});
export type AiSettings = z.infer<typeof AiSettings>;
