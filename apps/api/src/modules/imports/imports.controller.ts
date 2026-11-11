/**
 * Figma imports: a .fig upload (streamed to disk, then to the blob store) or a Figma link (REST, the project figma_token).
 * Either way a figma.import job parses the design, updates pages / sections / screens and renders the changed frames.
 */
import fs from "node:fs";
import {
  BadRequestException, Body, Controller, Get, Inject, Param, Post, UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ImportLinkRequest, type FigmaImport as ImportDto, type Me } from "@figtest/contracts";
import { blobKeys, loadEnv, tmpDir, type BlobStore } from "@figtest/core";
import { FigmaImport, Job, newId, type CredentialStore } from "@figtest/db";
import { parseFigmaUrl } from "@figtest/figma";
import { diskStorage } from "multer";
import { In, type DataSource } from "typeorm";
import { ZodPipe } from "../../common/zod.pipe";
import { BLOB, CREDENTIALS, DATA_SOURCE } from "../../infra/tokens";
import { CurrentUser } from "../auth/auth.decorators";
import { JobsService } from "../jobs/jobs.service";
import { ProjectsService } from "../projects/projects.service";

const env = loadEnv();
fs.mkdirSync(tmpDir(env.STORAGE_PATH), { recursive: true });

/** first bytes of a .fig: a zip (PK) or a bare canvas (fig-kiwi) */
async function looksLikeFig(file: string) {
  const fd = await fs.promises.open(file, "r");
  try {
    const head = Buffer.alloc(8);
    await fd.read(head, 0, 8, 0);
    return head.subarray(0, 2).toString() === "PK" || head.toString() === "fig-kiwi";
  } finally {
    await fd.close();
  }
}

@Controller("projects/:slug/imports")
export class ImportsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly jobs: JobsService,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(BLOB) private readonly blob: BlobStore,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
  ) {}

  @Get()
  async list(@Param("slug") slug: string): Promise<ImportDto[]> {
    const p = await this.projects.bySlug(slug);
    const rows = await this.ds.getRepository(FigmaImport).find({ where: { projectId: p.id }, order: { createdAt: "DESC" }, take: 50 });
    const jobIds = rows.map((r) => r.jobId).filter((x): x is string => !!x);
    const jobs = jobIds.length ? await this.ds.getRepository(Job).findBy({ id: In(jobIds) }) : [];
    const status = new Map(jobs.map((j) => [j.id, j.status]));
    return rows.map((r) => this.toDto(r, (r.jobId && status.get(r.jobId)) || "queued"));
  }

  @Post("fig")
  @UseInterceptors(FileInterceptor("file", {
    storage: diskStorage({ destination: tmpDir(env.STORAGE_PATH), filename: (_req, _file, cb) => cb(null, `${newId()}.upload`) }),
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  }))
  async uploadFig(@Param("slug") slug: string, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() me: Me): Promise<ImportDto> {
    if (!file) throw new BadRequestException("file: a .fig file (Figma: File > Save local copy)");
    try {
      const p = await this.projects.bySlug(slug);
      if (!(await looksLikeFig(file.path))) throw new BadRequestException("file: not a Figma .fig file");
      const repo = this.ds.getRepository(FigmaImport);
      const row = repo.create({ id: newId(), projectId: p.id, source: "fig", fileName: Buffer.from(file.originalname, "latin1").toString("utf8").slice(0, 300), fileKey: null, nodeId: null, createdBy: me.id });
      row.blobKey = blobKeys.importSource(p.id, row.id);
      await this.blob.put(row.blobKey, fs.createReadStream(file.path));
      await repo.save(row);
      const job = await this.jobs.start("figma.import", { projectId: p.id, createdBy: me.id }, { importId: row.id });
      row.jobId = job.id;
      await repo.save(row);
      return this.toDto(row, job.status);
    } finally {
      await fs.promises.rm(file.path, { force: true }).catch(() => {});
    }
  }

  @Post("link")
  async fromLink(@Param("slug") slug: string, @Body(new ZodPipe(ImportLinkRequest)) body: ImportLinkRequest, @CurrentUser() me: Me): Promise<ImportDto> {
    const p = await this.projects.bySlug(slug);
    if (!(await this.credentials.has(p.id, "figma_token"))) throw new BadRequestException("add a Figma access token in the project settings first");
    let parsed: { fileKey: string; nodeId: string | null };
    try {
      parsed = parseFigmaUrl(body.url);
    } catch (e) {
      throw new BadRequestException(`url: ${(e as Error).message}`);
    }
    const name = decodeURIComponent(new URL(body.url).pathname.split("/")[3] ?? parsed.fileKey).replace(/-/g, " ");
    const repo = this.ds.getRepository(FigmaImport);
    const row = await repo.save(repo.create({ projectId: p.id, source: "rest", fileName: name.slice(0, 300), fileKey: parsed.fileKey, nodeId: parsed.nodeId, blobKey: null, createdBy: me.id }));
    const job = await this.jobs.start("figma.import", { projectId: p.id, createdBy: me.id }, { importId: row.id });
    row.jobId = job.id;
    await repo.save(row);
    return this.toDto(row, job.status);
  }

  private toDto(r: FigmaImport, status: ImportDto["status"]): ImportDto {
    return {
      id: r.id, source: r.source, fileName: r.fileName, fileKey: r.fileKey, jobId: r.jobId, status,
      stats: (r.stats as ImportDto["stats"]) ?? null, createdAt: r.createdAt.toISOString(),
    };
  }
}
