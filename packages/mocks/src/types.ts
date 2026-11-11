/** Public types of @figtest/mocks (contract with the worker and the api: keep the names and fields). */
import type { MockOp } from "@figtest/contracts";

/** One API call seen while recording. Headers and cookies are never kept. */
export interface RecordedCall {
  method: string;
  url: string;
  host: string;
  path: string;
  query: Record<string, string>;
  /** GraphQL: operationName of the request body (or parsed from the query), else null */
  operationName: string | null;
  /** GraphQL variables, else null */
  variables: unknown;
  status: number;
  contentType: string;
  /** parsed JSON, or the text for other content types */
  body: unknown;
}

export interface Recorder {
  /** stops listening; the calls, one per distinct request (method, host, path, query, operationName, variables), last wins */
  stop(): Promise<RecordedCall[]>;
}

/** A route the page gets during a test (MockRoute row with its served body). */
export interface ServedRoute {
  id: string;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  operationName: string | null;
  variables: unknown;
  status: number;
  contentType: string;
  body: unknown;
}

export interface ReplayOptions {
  /** URL globs of the API (project apiInclude); empty = fetch/XHR requests to siteHost */
  include: string[];
  siteHost: string;
  /** an API request no route matches: it goes to the network and is reported ("POST /graphql op=GetCart") */
  onUnmatched: (description: string) => void;
}

export interface OpsResult {
  /** recorded body with the ops that pass the guards */
  body: unknown;
  /** ops refused, with the reason ("/data/items/0/price: number expected, got string") */
  violations: string[];
}

export interface StorybookExportInput {
  project: { name: string; slug: string };
  screens: {
    id: string;
    name: string;
    /** file-safe name */
    slug: string;
    storyId: string | null;
    viewport: { w: number; h: number };
    routes: ServedRoute[];
  }[];
}

export type { MockOp };
