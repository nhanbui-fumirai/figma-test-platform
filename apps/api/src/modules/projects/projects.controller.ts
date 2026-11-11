import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import {
  CredentialKind, CredentialPut, ProjectCreate, ProjectUpdate, type CredentialInfo, type Project,
} from "@figtest/contracts";
import { hintOf } from "@figtest/core";
import type { CredentialStore } from "@figtest/db";
import { ZodPipe } from "../../common/zod.pipe";
import { CREDENTIALS } from "../../infra/tokens";
import { ProjectsService, toProjectDto } from "./projects.service";

@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
  ) {}

  @Get()
  async list(): Promise<Project[]> {
    return (await this.projects.list()).map(toProjectDto);
  }

  @Get(":slug")
  async get(@Param("slug") slug: string): Promise<Project> {
    return toProjectDto(await this.projects.bySlug(slug));
  }

  @Post()
  async create(@Body(new ZodPipe(ProjectCreate)) body: ProjectCreate): Promise<Project> {
    return toProjectDto(await this.projects.create(body));
  }

  @Patch(":slug")
  async update(@Param("slug") slug: string, @Body(new ZodPipe(ProjectUpdate)) body: ProjectUpdate): Promise<Project> {
    return toProjectDto(await this.projects.update(slug, body));
  }

  // ---- secrets: written here, never read back (only a hint and non-secret meta)
  @Get(":slug/credentials")
  async credentialsOf(@Param("slug") slug: string): Promise<CredentialInfo[]> {
    const p = await this.projects.bySlug(slug);
    return (await this.credentials.list(p.id)).map((c) => ({ kind: c.kind, hint: c.hint, meta: c.meta, updatedAt: c.updatedAt.toISOString() }));
  }

  @Put(":slug/credentials")
  async putCredential(@Param("slug") slug: string, @Body(new ZodPipe(CredentialPut)) body: CredentialPut): Promise<CredentialInfo> {
    const p = await this.projects.bySlug(slug);
    const row = body.kind === "test_login"
      ? await this.credentials.put(p.id, body.kind, JSON.stringify(body.value), {
        // what the form may show again: everything but the password
        loginUrl: body.value.loginUrl, username: body.value.username, usernameSelector: body.value.usernameSelector,
        passwordSelector: body.value.passwordSelector, submitSelector: body.value.submitSelector, successSelector: body.value.successSelector,
      }, body.value.username)
      : await this.credentials.put(p.id, body.kind, body.value, {}, hintOf(body.value));
    return { kind: row.kind, hint: row.hint, meta: row.meta, updatedAt: row.updatedAt.toISOString() };
  }

  @Delete(":slug/credentials/:kind")
  async removeCredential(@Param("slug") slug: string, @Param("kind", new ZodPipe(CredentialKind)) kind: CredentialKind) {
    const p = await this.projects.bySlug(slug);
    await this.credentials.remove(p.id, kind);
    return { ok: true };
  }
}
