import { ApiError } from "@figtest/contracts";

/** Message of an error: an ApiError, a zod error of the client (body checked before sending), anything else. */
export function errorMessage(e: unknown): string {
  if (!e) return "";
  if (typeof e === "object" && "issues" in e && Array.isArray((e as { issues: unknown }).issues)) {
    const issues = (e as { issues: { path?: PropertyKey[]; message: string }[] }).issues;
    return issues.map((i) => (i.path?.length ? `${i.path.map(String).join(".")}: ` : "") + i.message).join(" · ");
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export const isApiError = (e: unknown, status?: number): e is ApiError => e instanceof ApiError && (status === undefined || e.status === status);

/** a job (or a run, an import) still queued or running */
export const isActive = (status: string | null | undefined) => status === "queued" || status === "running";

/** 0..1 → "87%" */
export const pct01 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
/** 0..100 → "87%" */
export const pct100 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v)}%`);

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "–");

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "–";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "–";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** time between two ISO dates (to now when the end is null) */
export const between = (start: string, end: string | null) => new Date(end ?? Date.now()).getTime() - new Date(start).getTime();

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** URL a screen opens: absolute, or a path of the project website (same rule as the api and the worker) */
export function resolveScreenUrl(baseUrl: string, url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : `${baseUrl.replace(/\/+$/, "")}/${u.replace(/^\/+/, "")}`;
}

export const storyUrl = (storybookUrl: string, storyId: string) => `${storybookUrl}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
