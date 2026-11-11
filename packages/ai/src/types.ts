/** Public types of @figtest/ai (contract with the worker: keep the names and fields). */
import type { MockOp, Step } from "@figtest/contracts";

export interface AiConfig {
  provider: "anthropic" | "openrouter";
  /** never logged */
  apiKey: string;
  model: string;
}

export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** null when the provider does not say and the price of the model is unknown */
  costUsd: number | null;
  ok: boolean;
  /** the `purpose` of the completeJson call ("steps", "mock-ops") */
  purpose?: string;
}

export type OnUsage = (usage: AiUsage) => void | Promise<void>;

export type AiContent = string | ({ type: "text"; text: string } | { type: "image"; png: Buffer })[];

export interface StepsInput {
  /** what the screen shows (the screen prompt, or "bring the page to the state of the design") */
  goal: string;
  /** texts of the design, in reading order */
  designTexts: string[];
  /** PNG of the design (downscaled by the caller), or null */
  designImage: Buffer | null;
  url: string;
  /** accessibility tree of the page now */
  ariaSnapshot: string;
  /** steps already run (and their outcome) */
  history: { step: Step; ok: boolean; error?: string }[];
}

export interface StepsOutput {
  /** next steps to run (empty when done) */
  steps: Step[];
  /** the page is in the state of the design */
  done: boolean;
  note: string;
}

export interface MockOpsInput {
  route: { method: string; path: string; operationName: string | null };
  /** the recorded body (may be large: the implementation trims arrays and long strings in the prompt) */
  body: unknown;
  designTexts: string[];
  designImage: Buffer | null;
}

export interface MockOpsOutput {
  ops: MockOp[];
  note: string;
}
