import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTree, readFile } from "./read";
import { gitEnv, GitError, maskSecrets, setSpawnObserver } from "./run";
import { BRANCH_FILE, removeRepository, syncRepository, syncWith } from "./sync";

const TOKEN = "ghp_TEST_token_0123456789abcdef";
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
const LONG_DIR = `deep/${Array.from({ length: 7 }, (_, i) => `a-rather-long-folder-name-number-${i}-xxxxxx`).join("/")}`;
const LONG_PATH = `${LONG_DIR}/the-file-at-the-end-of-a-long-path.txt`;
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

let root: string;
let src: string;
let srcUrl: string;
let copy: string;
let firstSha: string;
let gitConfigGlobal: string;
const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];

/** git in the test source repo (author set, no user/system config). */
function sh(cwd: string, args: string[], input?: string | Buffer): string {
  const r = spawnSync("git", args, {
    cwd,
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitConfigGlobal,
    },
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr?.toString()}`);
  return r.stdout.toString("utf8").trim();
}

/** A commit of these files on branch (no working tree files are written: names Windows refuses are fine). */
function commit(files: Record<string, string | Buffer>, branch: string, parent?: string): string {
  sh(src, ["read-tree", "--empty"]);
  for (const [path, content] of Object.entries(files)) {
    const sha = sh(src, ["hash-object", "-w", "--stdin"], content);
    sh(src, ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${sha},${path}`]);
  }
  const tree = sh(src, ["write-tree"]);
  const c = sh(src, ["commit-tree", tree, "-m", `commit on ${branch}`, ...(parent ? ["-p", parent] : [])]);
  sh(src, ["update-ref", `refs/heads/${branch}`, c]);
  return c;
}

const FILES: Record<string, string | Buffer> = {
  "README.md": "# Shop\n",
  "src/app/main.ts": "export const main = 1;\n",
  "src/app/util/helpers.ts": "export const help = 2;\n",
  "src/index.ts": "import './app/main';\n",
  "docs/guide.md": "Guide\n",
  "assets/logo.png": BINARY,
  "CON.txt": "a reserved name on Windows\n",
  "with space.txt": "spaced\n",
  "unicode.txt": "é".repeat(100),
  "big.txt": "x".repeat(20_000),
  "file10.txt": "10",
  "file2.txt": "2",
  [LONG_PATH]: "deep content\n",
};

async function filesOutsideObjects(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "objects") out.push(...(await filesOutsideObjects(p)));
    } else out.push(p);
  }
  return out;
}

async function rejects(p: Promise<unknown>, code: string): Promise<GitError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitError);
    expect((e as GitError).code).toBe(code);
    return e as GitError;
  }
  throw new Error(`test: expected a GitError ${code}`);
}

beforeAll(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "figtest-git-"));
  gitConfigGlobal = nodePath.join(root, "empty-gitconfig");
  await fs.writeFile(gitConfigGlobal, "");
  src = nodePath.join(root, "source");
  await fs.mkdir(src);
  sh(src, ["init", "-q"]);
  firstSha = commit(FILES, "main");
  srcUrl = pathToFileURL(src).href;
  copy = nodePath.join(root, "copies", "project-1");
  setSpawnObserver((args, env) => spawned.push({ args: [...args], env }));
}, 60_000);

afterAll(async () => {
  setSpawnObserver(null);
  if (root) await removeRepository(root);
});

describe("syncRepository", () => {
  it("rejects what is not an https URL, a branch or a token, before running git", async () => {
    const opts = { log: () => {} };
    const dir = nodePath.join(root, "never");
    const before = spawned.length;
    await rejects(syncRepository(dir, { url: "http://github.com/a/b.git", branch: "main", token: null }, opts), "invalid_url");
    await rejects(syncRepository(dir, { url: srcUrl, branch: "main", token: null }, opts), "invalid_url");
    await rejects(syncRepository(dir, { url: src, branch: "main", token: null }, opts), "invalid_url");
    await rejects(syncRepository(dir, { url: "ssh://git@github.com/a/b.git", branch: "main", token: null }, opts), "invalid_url");
    await rejects(syncRepository(dir, { url: `https://x-access-token:${TOKEN}@github.com/a/b.git`, branch: "main", token: null }, opts), "invalid_url");
    await rejects(syncRepository(dir, { url: "https://github.com/a/b.git", branch: "--upload-pack=evil", token: null }, opts), "invalid_branch");
    await rejects(syncRepository(dir, { url: "https://github.com/a/b.git", branch: "a..b", token: null }, opts), "invalid_branch");
    await rejects(syncRepository(dir, { url: "https://github.com/a/b.git", branch: "main", token: "abc\r\nX-Evil: 1" }, opts), "invalid_token");
    expect(spawned.length).toBe(before);
    expect(existsSync(dir)).toBe(false);
  });

  it("makes a bare copy of the branch with the token in the git environment only", async () => {
    spawned.length = 0;
    const logs: string[] = [];
    const { headSha } = await syncWith(copy, { url: srcUrl, branch: "main", token: TOKEN }, { log: (m) => void logs.push(m) }, { allowLocalRemote: true });
    expect(headSha).toBe(firstSha);
    // bare: git objects, nothing checked out
    expect(existsSync(nodePath.join(copy, "HEAD"))).toBe(true);
    expect(existsSync(nodePath.join(copy, "README.md"))).toBe(false);
    expect(existsSync(nodePath.join(copy, "shallow"))).toBe(true);
    expect((await fs.readFile(nodePath.join(copy, BRANCH_FILE), "utf8")).trim()).toBe("main");

    // argv never has the token; the fetch got it as an http.<origin>/.extraHeader entry of its environment
    expect(spawned.length).toBeGreaterThan(3);
    for (const s of spawned) {
      const argv = s.args.join(" ");
      expect(argv).not.toContain(TOKEN);
      expect(argv).not.toContain(BASIC);
    }
    const fetch = spawned.find((s) => s.args[0] === "fetch");
    expect(fetch?.args).toEqual(["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "origin", "+refs/heads/main:refs/heads/main"]);
    const env = fetch!.env;
    const entries = Object.keys(env)
      .filter((k) => k.startsWith("GIT_CONFIG_KEY_"))
      .map((k) => [env[k], env[k.replace("KEY", "VALUE")]]);
    expect(entries).toContainEqual(["http.https://localhost/.extraHeader", `Authorization: Basic ${BASIC}`]);
    expect(entries).toContainEqual(["credential.helper", ""]);
    expect(entries).toContainEqual(["core.longpaths", "true"]);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");

    // nothing written by git holds the token: config, FETCH_HEAD, logs, refs...
    const config = await fs.readFile(nodePath.join(copy, "config"), "utf8");
    expect(config).toMatch(/pushurl = read-only-clone-no-push/);
    expect(config).toMatch(/filemode = false/i);
    for (const f of await filesOutsideObjects(copy)) {
      const text = await fs.readFile(f, "latin1");
      expect(text, f).not.toContain(TOKEN);
      expect(text, f).not.toContain(BASIC);
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(TOKEN);
  }, 60_000);

  it("cannot push from the copy", async () => {
    const r = spawnSync("git", ["push", "origin", "refs/heads/main:refs/heads/pushed"], { cwd: copy, env: gitEnv([], { allowFile: true }), windowsHide: true });
    expect(r.status).not.toBe(0);
    expect(spawnSync("git", ["remote", "get-url", "--push", "origin"], { cwd: copy, windowsHide: true }).stdout.toString().trim()).toBe("read-only-clone-no-push");
    expect(() => sh(src, ["rev-parse", "--verify", "refs/heads/pushed"])).toThrow();
  });

  it("fetches the new commit of the branch, then another branch", async () => {
    const second = commit({ ...FILES, "README.md": "# Shop v2\n" }, "main", firstSha);
    const { headSha } = await syncWith(copy, { url: srcUrl, branch: "main", token: null }, { log: () => {} }, { allowLocalRemote: true });
    expect(headSha).toBe(second);
    expect((await readFile(copy, "README.md")).content).toBe("# Shop v2\n");

    const feature = commit({ "feature.txt": "on the feature branch\n" }, "feature/x");
    expect((await syncWith(copy, { url: srcUrl, branch: "feature/x", token: null }, { log: () => {} }, { allowLocalRemote: true })).headSha).toBe(feature);
    expect((await listTree(copy, "")).map((e) => e.name)).toEqual(["feature.txt"]);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/main"], { cwd: copy, windowsHide: true }).status).not.toBe(0);

    await syncWith(copy, { url: srcUrl, branch: "main", token: null }, { log: () => {} }, { allowLocalRemote: true });
    expect((await readFile(copy, "README.md")).content).toBe("# Shop v2\n");
  }, 60_000);

  it("reports a missing branch or remote without the token", async () => {
    const e1 = await rejects(syncWith(copy, { url: srcUrl, branch: "nope", token: TOKEN }, { log: () => {} }, { allowLocalRemote: true }), "git");
    expect(e1.message).toMatch(/git fetch failed: .*no branch "nope"/);
    const missing = pathToFileURL(nodePath.join(root, "missing-repo")).href;
    const e2 = await rejects(syncWith(nodePath.join(root, "copies", "p2"), { url: missing, branch: "main", token: TOKEN }, { log: () => {} }, { allowLocalRemote: true }), "git");
    for (const e of [e1, e2]) {
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain(BASIC);
    }
    expect(maskSecrets(`fatal: ${TOKEN} / ${BASIC} / Authorization: Bearer abc.def`, [TOKEN, BASIC])).toBe("fatal: *** / *** / Authorization: Bearer ***");
  }, 60_000);

  it("refuses to sync into a folder that is something else", async () => {
    const other = nodePath.join(root, "other");
    await fs.mkdir(other);
    await fs.writeFile(nodePath.join(other, "notes.txt"), "mine");
    await rejects(syncWith(other, { url: srcUrl, branch: "main", token: null }, { log: () => {} }, { allowLocalRemote: true }), "invalid_dir");
    expect(await fs.readFile(nodePath.join(other, "notes.txt"), "utf8")).toBe("mine");
  });
});

describe("listTree / readFile", () => {
  it("lists folders first then files, with sizes and full paths", async () => {
    const top = await listTree(copy, "");
    expect(top.map((e) => `${e.type}:${e.name}`)).toEqual([
      "dir:assets",
      "dir:deep",
      "dir:docs",
      "dir:src",
      "file:big.txt",
      "file:CON.txt",
      "file:file2.txt",
      "file:file10.txt",
      "file:README.md",
      "file:unicode.txt",
      "file:with space.txt",
    ]);
    expect(top.find((e) => e.name === "src")).toEqual({ path: "src", name: "src", type: "dir", size: null });
    expect(top.find((e) => e.name === "big.txt")).toEqual({ path: "big.txt", name: "big.txt", type: "file", size: 20_000 });
    expect(await listTree(copy, "src/app/")).toEqual([
      { path: "src/app/util", name: "util", type: "dir", size: null },
      { path: "src/app/main.ts", name: "main.ts", type: "file", size: 23 },
    ]);
    expect(await listTree(copy, LONG_DIR)).toEqual([{ path: LONG_PATH, name: "the-file-at-the-end-of-a-long-path.txt", type: "file", size: 13 }]);
    expect(LONG_PATH.length).toBeGreaterThan(260);
  });

  it("reads text, binary, reserved and long names", async () => {
    expect(await readFile(copy, "src/app/util/helpers.ts")).toEqual({ path: "src/app/util/helpers.ts", size: 23, binary: false, truncated: false, content: "export const help = 2;\n" });
    expect(await readFile(copy, "assets/logo.png")).toEqual({ path: "assets/logo.png", size: BINARY.length, binary: true, truncated: false, content: "" });
    expect((await readFile(copy, "CON.txt")).content).toBe("a reserved name on Windows\n");
    expect((await readFile(copy, "with space.txt")).content).toBe("spaced\n");
    expect((await readFile(copy, LONG_PATH)).content).toBe("deep content\n");
  });

  it("cuts text at maxBytes (never inside a UTF-8 character)", async () => {
    const big = await readFile(copy, "big.txt", 100);
    expect(big).toMatchObject({ size: 20_000, truncated: true, binary: false });
    expect(big.content).toBe("x".repeat(100));
    const uni = await readFile(copy, "unicode.txt", 5);
    expect(uni).toMatchObject({ size: 200, truncated: true, content: "éé" });
    expect((await readFile(copy, "unicode.txt")).content).toBe("é".repeat(100));
  });

  it("tells folders, files and missing paths apart", async () => {
    await rejects(readFile(copy, "src"), "not_a_file");
    await rejects(readFile(copy, "src/nothing.ts"), "not_found");
    await rejects(listTree(copy, "README.md"), "not_a_folder");
    await rejects(listTree(copy, "nothing"), "not_found");
    await rejects(listTree(nodePath.join(root, "not-synced"), ""), "not_synced");
  });

  it("rejects path tricks", async () => {
    const tricks = ["..", "../config", "a/../README.md", "./README.md", "src/./app", "/README.md", "C:/Windows", "C:README.md", "src\\app", "..\\config", "\\\\server\\share", "a//b", "README.md\0.png", "src/\napp", ""];
    for (const p of tricks) {
      await rejects(readFile(copy, p), "invalid_path");
      if (p !== "") await rejects(listTree(copy, p), "invalid_path");
    }
  });
});

describe("removeRepository", () => {
  it("removes the copy, read-only files included", async () => {
    const extra = nodePath.join(copy, "locked", "deeper");
    await fs.mkdir(extra, { recursive: true });
    await fs.writeFile(nodePath.join(extra, "ro.txt"), "read-only");
    await fs.chmod(nodePath.join(extra, "ro.txt"), 0o444);
    await removeRepository(copy);
    expect(existsSync(copy)).toBe(false);
    await removeRepository(copy); // already gone: fine
    await rejects(readFile(copy, "README.md"), "not_synced");
  });
});
