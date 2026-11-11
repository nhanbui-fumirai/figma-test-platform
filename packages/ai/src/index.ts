/**
 * @figtest/ai: AI providers behind one interface, JSON output validated with zod (repaired at most twice), and the two
 * prepare tasks of the platform. AI is only used to prepare a screen (steps, mock data); test runs never call it.
 *
 * PUBLIC CONTRACT: the worker codes against the exports below. Implementations live in the other files of src/.
 */
export type { AiConfig, AiUsage, AiContent, OnUsage, StepsInput, StepsOutput, MockOpsInput, MockOpsOutput } from "./types";
export { AiError, completeJson, DEFAULT_MODELS } from "./client";
export type { AiErrorCode } from "./client";
export { nextSteps } from "./steps";
export { mockOps } from "./mocks";
