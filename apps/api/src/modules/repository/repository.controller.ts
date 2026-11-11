/**
 * The source repository of a project, read-only: settings (URL, branch; the token is the github_token credential), a
 * git.sync job that clones / fetches a bare shallow copy, and a code browser over it (tree, file). Nothing here can
 * write to the repository: the copy has no working tree and its push URL is disabled.
 */
import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Put, Query } from "@nestjs/common";
import { RepositoryPut, type Job, type Me, type RepoEntry, type RepoFile, type Repository as RepoDto } from "@figtest/contracts";
import { repoDir, type Env } from "@figtest/core";
import { Repository, type CredentialStore } from "@figtest/db";
import { listTree, readFile, removeRepository } from "@figtest/git";
import type { DataSource } from "typeorm";
import { ZodPipe } from "../../common/zod.pipe";
import { CREDENTIALS, DATA_SOURCE, ENV } from "../../infra/tokens";
import { CurrentUser } from "../auth/auth.decorators";
import { JobsService, toJobDto } from "../jobs/jobs.service";
import { ProjectsService } from "../projects/projects.service";

const cleanPath = (p: string | undefined) => {
  const v = (p ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (v.split("/").some((part) => part === ".." || part === ".") || v.includes("\0")) throw new BadRequestException("path: not a path of the repository");
  return v;
};

@Controller("projects/:slug/repository")
export class RepositoryController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly jobs: JobsService,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get repo() {
    return this.ds.getRepository(Repository);
  }

  private async dto(r: Repository): Promise<RepoDto> {
    return {
      url: r.url, branch: r.branch, status: r.status, headSha: r.headSha, lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null, error: r.error,
      jobId: r.jobId, hasToken: await this.credentials.has(r.projectId, "github_token"),
    };
  }

  @Get()
  async get(@Param("slug") slug: string): Promise<RepoDto | null> {
    const p = await this.projects.bySlug(slug);
    const r = await this.repo.findOneBy({ projectId: p.id });
    return r ? this.dto(r) : null;
  }

  @Put()
  async put(@Param("slug") slug: string, @Body(new ZodPipe(RepositoryPut)) body: RepositoryPut): Promise<RepoDto> {
    const p = await this.projects.bySlug(slug);
    const r = (await this.repo.findOneBy({ projectId: p.id })) ?? this.repo.create({ projectId: p.id, status: "none" });
    const changed = r.url !== body.url || r.branch !== body.branch;
    r.url = body.url;
    r.branch = body.branch;
    if (changed && r.status !== "none") {
      await removeRepository(repoDir(this.env.STORAGE_PATH, p.id)).catch(() => {});
      Object.assign(r, { status: "none", headSha: null, lastSyncedAt: null, error: null });
    }
    return this.dto(await this.repo.save(r));
  }

  @Delete()
  async remove(@Param("slug") slug: string) {
    const p = await this.projects.bySlug(slug);
    await removeRepository(repoDir(this.env.STORAGE_PATH, p.id)).catch(() => {});
    await this.repo.delete({ projectId: p.id });
    return { ok: true };
  }

  @Post("sync")
  async sync(@Param("slug") slug: string, @CurrentUser() me: Me): Promise<Job> {
    const p = await this.projects.bySlug(slug);
    const r = await this.repo.findOneBy({ projectId: p.id });
    if (!r) throw new NotFoundException("set the repository URL first");
    if (r.status === "syncing" && r.jobId) {
      const running = await this.jobs.get(r.jobId).catch(() => null);
      if (running && ["queued", "running"].includes(running.status)) return toJobDto(running);
    }
    const job = await this.jobs.start("git.sync", { projectId: p.id, createdBy: me.id }, { projectId: p.id });
    await this.repo.update({ id: r.id }, { status: "syncing", jobId: job.id, error: null });
    return toJobDto(job);
  }

  private async ready(slug: string) {
    const p = await this.projects.bySlug(slug);
    const r = await this.repo.findOneBy({ projectId: p.id });
    if (!r?.headSha) throw new NotFoundException("the repository is not synced yet");
    return repoDir(this.env.STORAGE_PATH, p.id);
  }

  @Get("tree")
  async tree(@Param("slug") slug: string, @Query("path") path?: string): Promise<RepoEntry[]> {
    const dir = await this.ready(slug);
    try {
      return await listTree(dir, cleanPath(path));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Get("file")
  async file(@Param("slug") slug: string, @Query("path") path?: string): Promise<RepoFile> {
    const dir = await this.ready(slug);
    const p = cleanPath(path);
    if (!p) throw new BadRequestException("path: a file of the repository");
    try {
      return await readFile(dir, p, 512 * 1024);
    } catch (e) {
      throw new NotFoundException((e as Error).message);
    }
  }
}
