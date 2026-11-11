/**
 * @figtest/git: a read-only copy of a source repository. Bare shallow clone of one branch over https, the token only in
 * the environment of the git process (GIT_CONFIG_* http.<origin>/.extraHeader): never in argv, URLs, .git/config or logs.
 * credential.helper off, no prompt, push URL disabled; reads go through git (ls-tree, cat-file), nothing is checked out.
 *
 * PUBLIC CONTRACT: the worker and the api code against the exports below. Implementations live in the other files of src/.
 */
export interface RepoSpec {
  /** https only */
  url: string;
  branch: string;
  token: string | null;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: "dir" | "file";
  size: number | null;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  /** utf8 text ("" for binary) */
  content: string;
}

export { syncRepository, removeRepository } from "./sync";
export { listTree, readFile } from "./read";
/** errors of this package carry a code: invalid_url, invalid_branch, invalid_token, invalid_path, not_found, ... */
export { GitError } from "./run";
export type { GitErrorCode } from "./run";
