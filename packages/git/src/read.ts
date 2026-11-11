import nodePath from "node:path";
import type { FileContent, TreeEntry } from "./index";
import { checkRepoPath } from "./paths";
import { git, gitEnv, GitError, runGit } from "./run";
import { syncedBranch } from "./sync";

/** A NUL byte in the first bytes means binary (the rule git uses). */
const BINARY_SNIFF_BYTES = 8000;

/** Entries of a folder of the synced branch ("" = root), folders first. Rejects paths with "..", absolute or with a NUL. */
export async function listTree(dir: string, path: string): Promise<TreeEntry[]> {
  const p = checkRepoPath(path, { allowRoot: true });
  const { abs, ref } = await synced(dir);
  const env = gitEnv();
  if (p) {
    const info = await objectInfo(abs, `${ref}:${p}`, env);
    if (!info) throw new GitError(`no folder "${p}" in the branch`, "not_found");
    if (info.type !== "tree") throw new GitError(`"${p}" is not a folder`, "not_a_folder");
  }
  const out = await git(["ls-tree", "-l", "-z", p ? `${ref}:${p}` : ref], { cwd: abs, env });
  const dirs: TreeEntry[] = [];
  const files: TreeEntry[] = [];
  for (const record of out.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    // "<mode> <type> <object> <size>\t<name>" (size "-" for folders)
    const [, type, , size] = record.slice(0, tab).trim().split(/\s+/);
    const name = record.slice(tab + 1);
    const entryPath = p ? `${p}/${name}` : name;
    if (type === "tree") dirs.push({ path: entryPath, name, type: "dir", size: null });
    else if (type === "blob") files.push({ path: entryPath, name, type: "file", size: Number(size) || 0 });
    // "commit": a submodule, whose content is not in this repository
  }
  const byName = (a: TreeEntry, b: TreeEntry) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [...dirs.sort(byName), ...files.sort(byName)];
}

/** A file of the synced branch: text up to maxBytes (truncated beyond), binary detected (content ""). */
export async function readFile(dir: string, path: string, maxBytes = 512 * 1024): Promise<FileContent> {
  const p = checkRepoPath(path, { allowRoot: false });
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 512 * 1024;
  const { abs, ref } = await synced(dir);
  const env = gitEnv();
  const info = await objectInfo(abs, `${ref}:${p}`, env);
  if (!info) throw new GitError(`no file "${p}" in the branch`, "not_found");
  if (info.type !== "blob") throw new GitError(`"${p}" is not a file`, "not_a_file");

  // enough bytes to tell binary from text, and the text up to the limit
  const wanted = Math.min(info.size, Math.max(limit, BINARY_SNIFF_BYTES));
  const blob = wanted > 0 ? await git(["cat-file", "blob", info.sha], { cwd: abs, env, maxStdout: wanted }) : null;
  const bytes = blob ? blob.stdout.subarray(0, wanted) : Buffer.alloc(0);
  const binary = bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  if (binary) return { path: p, size: info.size, binary: true, truncated: false, content: "" };
  const truncated = info.size > limit;
  const text = truncated ? utf8Prefix(bytes.subarray(0, limit)) : bytes;
  return { path: p, size: info.size, binary: false, truncated, content: new TextDecoder("utf-8").decode(text) };
}

/** The bytes without a UTF-8 sequence cut at the end. */
function utf8Prefix(b: Buffer): Buffer {
  let i = b.length;
  // back to the lead byte of the last sequence (at most 3 continuation bytes)
  let back = 0;
  while (i > 0 && back < 4 && ((b[i - 1] ?? 0) & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i === 0) return b.subarray(0, 0);
  const lead = b[i - 1] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return need === back + 1 ? b : b.subarray(0, i - 1);
}

async function synced(dir: string): Promise<{ abs: string; ref: string }> {
  const abs = nodePath.resolve(dir);
  const branch = await syncedBranch(abs);
  if (!branch) throw new GitError("the repository is not synced yet", "not_synced");
  return { abs, ref: `refs/heads/${branch}` };
}

/** Type, id and size of "<ref>:<path>", or null when it does not exist. */
async function objectInfo(cwd: string, name: string, env: NodeJS.ProcessEnv): Promise<{ sha: string; type: string; size: number } | null> {
  const r = await runGit(["cat-file", "--batch-check"], { cwd, env, input: `${name}\n` });
  if (r.code !== 0) throw new GitError(`git cat-file failed: ${r.stderr.trim().slice(0, 300) || `exit code ${r.code}`}`);
  const line = r.stdout.toString("utf8").trim();
  const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
  if (!m) return null; // "<name> missing" / "ambiguous"
  return { sha: m[1]!, type: m[2]!, size: Number(m[3]) };
}
