import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ProjectSettings, type Project as ProjectDto, type ProjectCreate, type ProjectUpdate } from "@figtest/contracts";
import { Project } from "@figtest/db";
import type { DataSource } from "typeorm";
import { DATA_SOURCE } from "../../infra/tokens";

/** Settings as stored (jsonb), with the defaults of the fields added since. */
export const settingsOf = (p: Project) => ProjectSettings.parse(p.settings ?? {});

export const toProjectDto = (p: Project): ProjectDto => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  baseUrl: p.baseUrl,
  storybookUrl: p.storybookUrl,
  settings: settingsOf(p),
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

const trimSlash = (u: string) => u.replace(/\/+$/, "");

@Injectable()
export class ProjectsService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  private get repo() {
    return this.ds.getRepository(Project);
  }

  list() {
    return this.repo.find({ order: { createdAt: "DESC" } });
  }

  /** the project of a slug, or 404 */
  async bySlug(slug: string) {
    const p = await this.repo.findOneBy({ slug });
    if (!p) throw new NotFoundException(`project ${slug} not found`);
    return p;
  }

  async byId(id: string) {
    const p = await this.repo.findOneBy({ id });
    if (!p) throw new NotFoundException(`project ${id} not found`);
    return p;
  }

  async create(body: ProjectCreate) {
    if (await this.repo.existsBy({ slug: body.slug })) throw new ConflictException(`a project is already named ${body.slug}`);
    return this.repo.save(this.repo.create({ ...body, baseUrl: trimSlash(body.baseUrl), settings: {}, storybookUrl: null }));
  }

  async update(slug: string, body: ProjectUpdate) {
    const p = await this.bySlug(slug);
    if (body.name !== undefined) p.name = body.name;
    if (body.baseUrl !== undefined) p.baseUrl = trimSlash(body.baseUrl);
    if (body.storybookUrl !== undefined) p.storybookUrl = body.storybookUrl ? trimSlash(body.storybookUrl) : null;
    if (body.settings) p.settings = { ...settingsOf(p), ...body.settings };
    return this.repo.save(p);
  }
}
