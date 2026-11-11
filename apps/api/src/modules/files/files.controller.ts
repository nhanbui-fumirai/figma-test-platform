/**
 * Blobs for the web (design images, thumbnails, screenshots): GET /api/files/<key>, session cookie required. Keys are
 * written once (a new revision or result gets a new key), so the browser may cache them.
 */
import { Controller, Get, Inject, NotFoundException, Param, Res } from "@nestjs/common";
import { checkKey, type BlobStore } from "@figtest/core";
import type { Response } from "express";
import { BLOB } from "../../infra/tokens";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", json: "application/json", gz: "application/gzip" };

@Controller("files")
export class FilesController {
  constructor(@Inject(BLOB) private readonly blob: BlobStore) {}

  @Get("*key")
  async get(@Param("key") key: string | string[], @Res() res: Response) {
    const k = Array.isArray(key) ? key.join("/") : key;
    try {
      checkKey(k);
    } catch {
      throw new NotFoundException();
    }
    if (!k.startsWith("projects/") || k.endsWith(".fig") || !(await this.blob.exists(k))) throw new NotFoundException();
    res.setHeader("Content-Type", TYPES[k.split(".").pop() ?? ""] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    this.blob.stream(k).on("error", () => res.destroy()).pipe(res);
  }
}
