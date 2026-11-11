/** Internal: checks of what the callers give (repository URL, branch, token, paths inside the repository). */
import nodePath from "node:path";
import { GitError } from "./run";

/** The push URL of every copy: not a repository, so a push always fails (whatever the token may allow). */
export const NO_PUSH_URL = "read-only-clone-no-push";

export interface CheckedUrl {
  url: string;
  /** "https://host[:port]" (null for a local test remote) */
  origin: string | null;
  host: string | null;
}

/** https only, without user or password in it. allowLocal (tests only): also file:// URLs and absolute paths. */
export function checkUrl(raw: string, allowLocal = false): CheckedUrl {
  const url = String(raw ?? "").trim();
  if (!url) throw new GitError("the repository URL is empty", "invalid_url");
  if (/[\s\x00-\x1f\x7f]/.test(url)) throw new GitError("the repository URL has spaces or control characters", "invalid_url");
  if (url.startsWith("-")) throw new GitError("the repository URL cannot start with -", "invalid_url");
  if (allowLocal && (url.startsWith("file://") || nodePath.isAbsolute(url))) return { url, origin: null, host: null };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GitError("the repository URL is not a URL (e.g. https://github.com/team/web.git)", "invalid_url");
  }
  if (u.protocol !== "https:") throw new GitError("the repository URL must be https (the token is sent as an HTTP header)", "invalid_url");
  if (u.username || u.password) throw new GitError("the repository URL must not hold a user or a token (the token has its own field)", "invalid_url");
  if (!u.hostname) throw new GitError("the repository URL has no host", "invalid_url");
  return { url, origin: u.origin, host: u.hostname.toLowerCase() };
}

/** A branch name git accepts, and nothing that could read as an option or a revision expression. */
export function checkBranch(raw: string): string {
  const b = String(raw ?? "").trim();
  const bad =
    !b ||
    b.length > 250 ||
    !/^[\w./-]+$/.test(b) ||
    /^[-./]/.test(b) ||
    /\/$|\.$|\.lock$/.test(b) ||
    b.includes("..") ||
    b.includes("//") ||
    b.includes("/.");
  if (bad) throw new GitError(`"${b.slice(0, 80)}" is not a branch name (letters, digits, . / _ -)`, "invalid_branch");
  return b;
}

/** A token that can go in an HTTP header (no spaces, no control characters), or null. */
export function checkToken(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (/[\s\x00-\x1f\x7f]/.test(t)) throw new GitError("the access token has spaces or control characters", "invalid_token");
  return t;
}

/**
 * A path inside the repository, normalized ("src/app", "" for the root when allowed). Rejected: absolute paths (/x,
 * C:\x, C:x), backslashes, "." and ".." segments, empty segments, NUL and other control characters.
 */
export function checkRepoPath(raw: string, opts: { allowRoot: boolean }): string {
  if (typeof raw !== "string") throw new GitError("the path must be a string", "invalid_path");
  let p = raw;
  if (p.length > 4096) throw new GitError("the path is too long", "invalid_path");
  if (/[\x00-\x1f\x7f]/.test(p)) throw new GitError("the path has a NUL or a control character", "invalid_path");
  if (p.includes("\\")) throw new GitError("the path has a backslash (use / between folders)", "invalid_path");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new GitError("the path must be relative to the root of the repository", "invalid_path");
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") {
    if (opts.allowRoot) return "";
    throw new GitError("the path is empty", "invalid_path");
  }
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new GitError(`the path may not have "${seg || "//"}" in it`, "invalid_path");
  }
  return p;
}
