/**
 * Typed client of the API for the web app (and scripts). Calls go straight to the API origin with the session cookie
 * (credentials: include): no proxy in between, so uploads and the SSE streams are not buffered.
 */
import type { z } from "zod";
import { ApiErrorBody, DemoJobRequest, Job, JobLogLine, LoginRequest, Me, Project, ProjectCreate, ProjectUpdate } from "./schemas";
import {
  AiStepsRequest, AiUsage, CredentialInfo, CredentialPut, FigmaImport, GroupUpdate, ImportLinkRequest, MockRoute, MockRouteCreate,
  MockRouteSummary, MockRouteUpdate, Preview, RepoEntry, RepoFile, Repository, RepositoryPut, ResultReport, Run, RunCreate, RunDetail,
  Screen, ScreenGroup, ScreenListQuery, ScreenPage, ScreenUpdate,
} from "./api";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

type Fetch = typeof fetch;

export function createApiClient(baseUrl: string, fetchImpl: Fetch = (...a) => fetch(...a)) {
  const root = baseUrl.replace(/\/+$/, "");

  async function call<S extends z.ZodType>(schema: S | null, method: string, path: string, body?: unknown): Promise<z.infer<S>> {
    const form = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await fetchImpl(`${root}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined || form ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = ApiErrorBody.safeParse(json);
      throw new ApiError(res.status, err.success ? err.data.message : `${res.status} ${res.statusText}`, err.success ? err.data.details : undefined);
    }
    return (schema ? schema.parse(json) : json) as z.infer<S>;
  }

  const p = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;
  const qs = (o: Record<string, unknown>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
    const s = u.toString();
    return s ? `?${s}` : "";
  };

  return {
    /** absolute URL of a file path the API returned (/api/files/...) */
    fileUrl: (path: string | null | undefined) => (path ? `${root}${path}` : null),
    auth: {
      login: (body: LoginRequest) => call(Me, "POST", "/api/auth/login", LoginRequest.parse(body)),
      logout: () => call(null, "POST", "/api/auth/logout"),
      me: () => call(Me, "GET", "/api/auth/me"),
    },
    projects: {
      list: () => call(Project.array(), "GET", "/api/projects"),
      get: (slug: string) => call(Project, "GET", `/api/projects/${encodeURIComponent(slug)}`),
      create: (body: ProjectCreate) => call(Project, "POST", "/api/projects", ProjectCreate.parse(body)),
      update: (slug: string, body: ProjectUpdate) => call(Project, "PATCH", p(slug), ProjectUpdate.parse(body)),
    },
    credentials: {
      list: (slug: string) => call(CredentialInfo.array(), "GET", `${p(slug)}/credentials`),
      put: (slug: string, body: CredentialPut) => call(CredentialInfo, "PUT", `${p(slug)}/credentials`, CredentialPut.parse(body)),
      remove: (slug: string, kind: CredentialInfo["kind"]) => call(null, "DELETE", `${p(slug)}/credentials/${kind}`),
    },
    imports: {
      list: (slug: string) => call(FigmaImport.array(), "GET", `${p(slug)}/imports`),
      /** multipart upload of a .fig file (Figma: File > Save local copy) */
      uploadFig: (slug: string, file: Blob, fileName: string) => {
        const form = new FormData();
        form.append("file", file, fileName);
        return call(FigmaImport, "POST", `${p(slug)}/imports/fig`, form);
      },
      fromLink: (slug: string, body: ImportLinkRequest) => call(FigmaImport, "POST", `${p(slug)}/imports/link`, ImportLinkRequest.parse(body)),
    },
    groups: {
      list: (slug: string) => call(ScreenGroup.array(), "GET", `${p(slug)}/groups`),
      update: (id: string, body: GroupUpdate) => call(ScreenGroup, "PATCH", `/api/groups/${id}`, GroupUpdate.parse(body)),
    },
    screens: {
      list: (slug: string, query: ScreenListQuery = {}) => call(ScreenPage, "GET", `${p(slug)}/screens${qs(query)}`),
      get: (id: string) => call(Screen, "GET", `/api/screens/${id}`),
      update: (id: string, body: ScreenUpdate) => call(Screen, "PATCH", `/api/screens/${id}`, ScreenUpdate.parse(body)),
      /** opens the page like a test (state, login, mocks) without comparing: a job, then lastPreview */
      preview: (id: string) => call(Job, "POST", `/api/screens/${id}/preview`),
      lastPreview: (id: string) => call(Preview.nullable(), "GET", `/api/screens/${id}/preview`),
    },
    runs: {
      list: (slug: string) => call(Run.array(), "GET", `${p(slug)}/runs`),
      create: (slug: string, body: RunCreate = {}) => call(Run, "POST", `${p(slug)}/runs`, RunCreate.parse(body)),
      get: (id: string) => call(RunDetail, "GET", `/api/runs/${id}`),
      cancel: (id: string) => call(Run, "POST", `/api/runs/${id}/cancel`),
    },
    results: {
      report: (id: string) => call(ResultReport, "GET", `/api/results/${id}/report`),
    },
    mocks: {
      list: (screenId: string) => call(MockRouteSummary.array(), "GET", `/api/screens/${screenId}/mocks`),
      get: (id: string) => call(MockRoute, "GET", `/api/mocks/${id}`),
      create: (screenId: string, body: MockRouteCreate) => call(MockRoute, "POST", `/api/screens/${screenId}/mocks`, MockRouteCreate.parse(body)),
      update: (id: string, body: MockRouteUpdate) => call(MockRoute, "PATCH", `/api/mocks/${id}`, MockRouteUpdate.parse(body)),
      remove: (id: string) => call(null, "DELETE", `/api/mocks/${id}`),
      /** records the API calls of the page (project apiInclude globs) as the mocks of the screen: a job */
      record: (screenId: string) => call(Job, "POST", `/api/screens/${screenId}/mocks/record`),
    },
    ai: {
      steps: (screenId: string, body: AiStepsRequest = {}) => call(Job, "POST", `/api/screens/${screenId}/ai/steps`, AiStepsRequest.parse(body)),
      mocks: (screenId: string) => call(Job, "POST", `/api/screens/${screenId}/ai/mocks`),
      usage: (slug: string) => call(AiUsage, "GET", `${p(slug)}/ai/usage`),
    },
    repository: {
      get: (slug: string) => call(Repository.nullable(), "GET", `${p(slug)}/repository`),
      put: (slug: string, body: RepositoryPut) => call(Repository, "PUT", `${p(slug)}/repository`, RepositoryPut.parse(body)),
      remove: (slug: string) => call(null, "DELETE", `${p(slug)}/repository`),
      sync: (slug: string) => call(Job, "POST", `${p(slug)}/repository/sync`),
      tree: (slug: string, path = "") => call(RepoEntry.array(), "GET", `${p(slug)}/repository/tree${qs({ path })}`),
      file: (slug: string, path: string) => call(RepoFile, "GET", `${p(slug)}/repository/file${qs({ path })}`),
    },
    storybook: {
      /** GET: a zip of MSW handlers, fixtures and stories made from the mocks of the screens */
      exportUrl: (slug: string) => `${root}${p(slug)}/storybook/export`,
    },
    jobs: {
      get: (id: string) => call(Job, "GET", `/api/jobs/${id}`),
      logs: (id: string, after = 0) => call(JobLogLine.array(), "GET", `/api/jobs/${id}/logs?after=${after}`),
      listForProject: (slug: string) => call(Job.array(), "GET", `/api/projects/${encodeURIComponent(slug)}/jobs`),
      startDemo: (slug: string, body: Partial<DemoJobRequest> = {}) => call(Job, "POST", `/api/projects/${encodeURIComponent(slug)}/jobs/demo`, DemoJobRequest.parse(body)),
      cancel: (id: string) => call(Job, "POST", `/api/jobs/${id}/cancel`),
      /** URL of the SSE stream (EventSource with withCredentials: true) */
      eventsUrl: (id: string) => `${root}/api/jobs/${id}/events`,
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
