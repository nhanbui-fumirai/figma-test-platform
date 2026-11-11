import { promises as fs } from "node:fs";
import nodePath from "node:path";
import type { RepoSpec } from "./index";
import { checkBranch, checkToken, checkUrl, NO_PUSH_URL } from "./paths";
import { git, gitEnv, GitError, lastLines, maskSecrets, runGit, type RunOptions } from "./run";

/** File of the bare copy that names the synced branch (what the read functions read). */
export const BRANCH_FILE = "FIGTEST_BRANCH";
const FETCH_TIMEOUT_MS = 15 * 60_000;

/** Clones (bare, depth 1, one branch) into dir, or fetches when it is there; returns the commit of the branch. */
export async function syncRepository(dir: string, spec: RepoSpec, opts: { log: (message: string) => void | Promise<void>; signal?: AbortSignal }): Promise<{ headSha: string }> {
  return syncWith(dir, spec, opts, {});
}

/**
 * syncRepository with internal options. allowLocalRemote (tests only): the URL may be file:// or a local path; the
 * public syncRepository never allows it.
 */
export async function syncWith(
  dir: string,
  spec: RepoSpec,
  opts: { log: (message: string) => void | Promise<void>; signal?: AbortSignal },
  internal: { allowLocalRemote?: boolean },
): Promise<{ headSha: string }> {
  const remote = checkUrl(spec.url, internal.allowLocalRemote === true);
  const branch = checkBranch(spec.branch);
  const token = checkToken(spec.token);

  // the token: an HTTP header of the git process, for the origin of the repository only, never in argv/URL/config
  const secrets: string[] = [];
  const extra: [string, string][] = [];
  if (token) {
    const basic = Buffer.from(`${userFor(remote.host)}:${token}`).toString("base64");
    secrets.push(token, basic);
    const scope = remote.origin ? `${remote.origin}/` : "https://localhost/";
    extra.push([`http.${scope}.extraHeader`, `Authorization: Basic ${basic}`]);
    // a redirect must not carry the header to another host
    extra.push(["http.followRedirects", "false"]);
  }
  const env = gitEnv(extra, { allowFile: internal.allowLocalRemote === true });
  const abs = nodePath.resolve(dir);
  const run = (cwd: string): RunOptions => ({ cwd, env, secrets, signal: opts.signal });
  const log = async (message: string) => {
    try {
      await opts.log(maskSecrets(message, secrets));
    } catch {
      /* a failing logger does not stop the sync */
    }
  };

  try {
    let fresh = !(await isBareCopy(abs));
    if (!fresh) {
      const current = await runGit(["config", "--get", "remote.origin.url"], run(abs));
      if (current.stdout.toString("utf8").trim() !== remote.url) {
        await log("The repository URL changed: the copy is made again");
        await removeRepository(abs);
        fresh = true;
      }
    }
    if (fresh) {
      if ((await fs.readdir(abs).catch(() => [])).length) throw new GitError(`${abs} is not empty and is not a copy of a repository`, "invalid_dir");
      await fs.mkdir(abs, { recursive: true });
      await log("Creating the read-only copy");
      await git(["init", "--bare", "--quiet"], run(abs));
    }
    // every time (a copy made by an older version gets them too): the remote, no push, file modes ignored
    await git(["config", "remote.origin.url", remote.url], run(abs));
    await git(["config", "remote.origin.pushurl", NO_PUSH_URL], run(abs));
    await git(["config", "core.fileMode", "false"], run(abs));

    await log(`Fetching ${branch} (latest commit only)`);
    const ref = `refs/heads/${branch}`;
    const fetched = await runGit(["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "origin", `+${ref}:${ref}`], {
      ...run(abs),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (fetched.code !== 0) throw new GitError(`git fetch failed: ${lastLines(fetched.stderr) || `exit code ${fetched.code}`}${fetchHint(fetched.stderr, branch)}`);

    await git(["symbolic-ref", "HEAD", ref], run(abs));
    const previous = await syncedBranch(abs);
    if (previous && previous !== branch) await runGit(["update-ref", "-d", `refs/heads/${previous}`], run(abs));
    await fs.writeFile(nodePath.join(abs, BRANCH_FILE), `${branch}\n`, "utf8");

    const sha = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], run(abs))).stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError(`no commit for ${branch}`);
    await log(`At commit ${sha.slice(0, 12)}`);
    return { headSha: sha };
  } catch (e) {
    if (e instanceof GitError) throw new GitError(maskSecrets(e.message, secrets), e.code);
    throw new GitError(maskSecrets(e instanceof Error ? e.message : String(e), secrets));
  }
}

/** The HTTPS user sent with the token: what the host expects for an access token. */
function userFor(host: string | null): string {
  return host === "bitbucket.org" ? "x-token-auth" : "x-access-token";
}

function fetchHint(stderr: string, branch: string): string {
  if (/couldn't find remote ref|could not find remote ref/i.test(stderr)) return ` (no branch "${branch}" in the repository)`;
  if (/terminal prompts disabled|authentication failed|could not read (username|password)|\b40[13]\b/i.test(stderr))
    return " (the repository needs an access token, or the token cannot read it)";
  if (/redirect|\b30[1278]\b/i.test(stderr)) return " (the server redirects: use the URL it redirects to, e.g. ending in .git)";
  return "";
}

async function isBareCopy(dir: string): Promise<boolean> {
  const has = (p: string) => fs.stat(nodePath.join(dir, p)).then(() => true, () => false);
  return (await has("HEAD")) && (await has("config")) && (await has("objects")) && !(await has(".git"));
}

/** The branch of the last sync, or null. */
export async function syncedBranch(dir: string): Promise<string | null> {
  try {
    const b = (await fs.readFile(nodePath.join(dir, BRANCH_FILE), "utf8")).trim();
    return b || null;
  } catch {
    return null;
  }
}

/** Deletes the copy (read-only files included). */
export async function removeRepository(dir: string): Promise<void> {
  const abs = nodePath.resolve(dir);
  if (nodePath.parse(abs).root === abs) throw new GitError(`will not remove ${abs}`, "invalid_dir");
  try {
    await fs.lstat(abs);
  } catch {
    return;
  }
  await makeWritable(abs);
  await fs.rm(abs, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Git writes its objects read-only: give write access back before removing (Windows refuses otherwise). */
async function makeWritable(dir: string): Promise<void> {
  await fs.chmod(dir, 0o777).catch(() => {});
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) await makeWritable(p);
    else if (e.isFile()) await fs.chmod(p, 0o666).catch(() => {});
  }
}
