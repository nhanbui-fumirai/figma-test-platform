/**
 * Where things live in the blob store: one place for the api (serves them) and the worker (writes them). Everything of a
 * project is under projects/<projectId>/, so deleting a project is one deletePrefix.
 */
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const blobKeys = {
  project: (projectId: string) => `projects/${projectId}`,
  importSource: (projectId: string, importId: string) => `projects/${projectId}/imports/${importId}/source.fig`,
  revision: (projectId: string, screenId: string, revisionId: string) => ({
    image: `projects/${projectId}/screens/${screenId}/rev/${revisionId}/design.png`,
    thumb: `projects/${projectId}/screens/${screenId}/rev/${revisionId}/thumb.png`,
    spec: `projects/${projectId}/screens/${screenId}/rev/${revisionId}/spec.json.gz`,
  }),
  preview: (projectId: string, screenId: string, jobId: string) => `projects/${projectId}/screens/${screenId}/preview/${jobId}.png`,
  result: (projectId: string, runId: string, resultId: string) => ({
    screenshot: `projects/${projectId}/runs/${runId}/${resultId}/screenshot.png`,
    report: `projects/${projectId}/runs/${runId}/${resultId}/report.json.gz`,
    dom: `projects/${projectId}/runs/${runId}/${resultId}/dom.json.gz`,
  }),
};

/** The bare git copy of a project repository (outside the blob store: git needs a real folder). */
export const repoDir = (storagePath: string, projectId: string) => path.join(storagePath, "repos", `${projectId}.git`);

/** Folder for uploads in progress. */
export const tmpDir = (storagePath: string) => path.join(storagePath, "tmp");

/** URL path the api serves a blob at (session cookie). */
export const fileUrl = (key: string | null | undefined) => (key ? `/api/files/${key}` : null);

export const gzipJson = (value: unknown) => gzip(Buffer.from(JSON.stringify(value)));
export const gunzipJson = async <T>(buf: Buffer): Promise<T> => JSON.parse((await gunzip(buf)).toString("utf8")) as T;
