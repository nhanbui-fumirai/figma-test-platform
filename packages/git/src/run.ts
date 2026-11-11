/**
 * Internal: runs git without a shell and without a prompt. The token only ever travels in the environment of one git
 * process (GIT_CONFIG_* entries), and every text that leaves this module has it masked.
 */
import { spawn } from "node:child_process";

export type GitErrorCode =
  | "invalid_url"
  | "invalid_branch"
  | "invalid_token"
  | "invalid_path"
  | "invalid_dir"
  | "not_synced"
  | "not_found"
  | "not_a_folder"
  | "not_a_file"
  | "cancelled"
  | "git";

export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(message: string, code: GitErrorCode = "git") {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

/** Inherited variables that would point git elsewhere, add config, trace requests (headers) or prompt. */
const DROPPED_ENV =
  /^(GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG.*|TRACE.*|CURL_VERBOSE|REDACT_COOKIES|ASKPASS|TERMINAL_PROMPT|SSH|SSH_COMMAND|SSH_VARIANT|PROXY_COMMAND|EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|ALLOW_PROTOCOL|PROTOCOL_FROM_USER)|SSH_ASKPASS|GCM_.*)$/i;

/**
 * Environment of a git process: no prompt of any kind, no system config, no credential helper, long paths on, only the
 * https protocol (file too when allowFile, for tests), plus the extra config entries (the auth header goes there).
 */
export function gitEnv(extra: [string, string][] = [], opts: { allowFile?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROPPED_ENV.test(k)) env[k] = v;
  const config: [string, string][] = [
    ["credential.helper", ""],
    ["core.longpaths", "true"],
    ["core.askPass", ""],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ...(opts.allowFile ? ([["protocol.file.allow", "always"]] as [string, string][]) : []),
    ...extra,
  ];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GCM_INTERACTIVE = "never";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Replaces the secrets, and any Authorization header value, by ***. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out.replace(/(authorization:\s*(?:basic|bearer|token)\s+)[^\s'"]+/gi, "$1***");
}

export interface RunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** masked in stderr and in error messages */
  secrets?: readonly string[];
  signal?: AbortSignal;
  /** written to stdin */
  input?: string;
  /** stop after this many bytes of stdout (the process is ended; the result is not an error) */
  maxStdout?: number;
  timeoutMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  /** masked */
  stderr: string;
  /** maxStdout was reached */
  cut: boolean;
}

type SpawnObserver = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string | undefined) => void;
let observer: SpawnObserver | null = null;

/** For tests only: sees the argv and env of every git process. */
export function setSpawnObserver(fn: SpawnObserver | null): void {
  observer = fn;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Runs git (no shell). Resolves with the exit code; rejects only when git cannot run, is cancelled or times out. */
export function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
  const secrets = opts.secrets ?? [];
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new GitError("cancelled", "cancelled"));
    observer?.(args, opts.env, opts.cwd);
    const child = spawn("git", args, { cwd: opts.cwd, env: opts.env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (d: Buffer) => {
      if (cut) return;
      if (opts.maxStdout !== undefined && size + d.length >= opts.maxStdout) {
        chunks.push(d.subarray(0, opts.maxStdout - size));
        size = opts.maxStdout;
        cut = true;
        child.kill();
        return;
      }
      chunks.push(d);
      size += d.length;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 100_000) stderr += d.toString("utf8");
    });
    child.stdin.on("error", () => {
      /* EPIPE when git exits early */
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (e: NodeJS.ErrnoException) => {
      cleanup();
      reject(new GitError(e.code === "ENOENT" ? "git is not installed (not found on PATH)" : `git could not start: ${maskSecrets(e.message, secrets)}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (opts.signal?.aborted) return reject(new GitError("cancelled", "cancelled"));
      if (timedOut) return reject(new GitError(`git ${args[0] ?? ""} took too long and was stopped`));
      resolve({ code, stdout: Buffer.concat(chunks), stderr: maskSecrets(stderr, secrets), cut });
    });

    child.stdin.end(opts.input ?? "");
  });
}

/** Runs git and throws a GitError (masked, last lines of stderr) when it fails. */
export async function git(args: string[], opts: RunOptions): Promise<RunResult> {
  const r = await runGit(args, opts);
  if (r.code !== 0 && !r.cut) throw new GitError(`git ${args[0] ?? ""} failed: ${lastLines(r.stderr) || `exit code ${r.code}`}`);
  return r;
}

/** The meaningful end of git's stderr, on one line. */
export function lastLines(stderr: string, n = 3): string {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/i.test(l))
    .slice(-n)
    .join(" ")
    .slice(0, 600);
}
