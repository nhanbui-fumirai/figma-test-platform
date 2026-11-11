/**
 * Big files (uploaded .fig, frame images, specs, DOM snapshots, screenshots, reports) live in a blob store, the database
 * keeps their keys. Keys are portable paths: lowercase letters, digits, - _ . and / (no ":" of Figma ids, no "..", valid
 * on Windows). FsBlobStore keeps them on disk under STORAGE_DIR/blobs; an S3 store can implement the same interface.
 */
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export interface BlobStore {
  put(key: string, data: Buffer | string | Readable): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Readable;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  delete(key: string): Promise<void>;
  /** removes every key under the prefix (a project, a run) */
  deletePrefix(prefix: string): Promise<void>;
}

const KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export function checkKey(key: string) {
  if (!KEY.test(key) || key.includes("..")) throw new Error(`invalid blob key "${key}": a-z 0-9 . _ - and / only`);
  return key;
}

export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private file(key: string) {
    return path.join(this.root, ...checkKey(key).split("/"));
  }

  async put(key: string, data: Buffer | string | Readable) {
    const file = this.file(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // written next to it, then renamed: a reader never sees half a file
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    if (typeof data === "string" || Buffer.isBuffer(data)) await fs.promises.writeFile(tmp, data);
    else await pipeline(data, fs.createWriteStream(tmp));
    await renameWithRetry(tmp, file);
  }

  get(key: string) {
    return fs.promises.readFile(this.file(key));
  }

  stream(key: string) {
    return fs.createReadStream(this.file(key));
  }

  async exists(key: string) {
    return fs.promises.access(this.file(key)).then(() => true, () => false);
  }

  async size(key: string) {
    return (await fs.promises.stat(this.file(key))).size;
  }

  async delete(key: string) {
    await fs.promises.rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    await fs.promises.rm(path.join(this.root, ...checkKey(prefix).split("/")), { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Windows: an antivirus or the indexer may hold the file for a moment (EBUSY / EPERM). */
async function renameWithRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || !["EBUSY", "EPERM", "EACCES"].includes(code ?? "")) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}
