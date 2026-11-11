/**
 * @figtest/mocks: the API data of a screen. Records the API calls of a page (bodies only, never headers or cookies),
 * replays them (GraphQL by operationName + closest variables, REST by method + path + closest query), applies the
 * edits (ops) of the AI or a human on top of the recorded body with guards, and exports MSW handlers + Storybook stories.
 *
 * PUBLIC CONTRACT: the worker and the api code against the exports below. Implementations live in the other files of src/.
 */
export type { RecordedCall, Recorder, ServedRoute, ReplayOptions, StorybookExportInput, OpsResult } from "./types";
export { startRecording } from "./record";
export { matchRoute, installMocks } from "./replay";
export { applyOps, applyOpsChecked } from "./ops";
export { exportStorybook } from "./storybook";
