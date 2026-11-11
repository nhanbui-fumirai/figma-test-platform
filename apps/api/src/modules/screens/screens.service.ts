/**
 * Pages / sections and screens of a project: the list with search and filters, the config of a screen (URL, cookies,
 * login, steps, prompt, target), hiding. A hidden group hides its screens without touching them, so a screen a later
 * import adds to it is hidden too.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  Preview, ResultStatus, Screen as ScreenDto, ScreenGroup as GroupDto, ScreenListQuery, ScreenPage, ScreenUpdate,
} from "@figtest/contracts";
import { ScreenListQuery as ListSchema } from "@figtest/contracts";
import { fileUrl } from "@figtest/core";
import { MockRoute, Result, Screen, ScreenGroup, ScreenRevision } from "@figtest/db";
import { Brackets, In, type DataSource } from "typeorm";
import { DATA_SOURCE } from "../../infra/tokens";

export type GroupIndex = {
  groups: ScreenGroup[];
  byId: Map<string, ScreenGroup>;
  /** names from the page down to the group */
  path(groupId: string | null): string[];
  /** depth-first order of the groups (pages, then their sections) */
  order: Map<string, number>;
  /** the group and the groups inside it */
  descendants(groupId: string): Set<string>;
  /** groups hidden by themselves or by a hidden ancestor */
  hidden: Set<string>;
};

export function indexGroups(groups: ScreenGroup[]): GroupIndex {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const kids = new Map<string | null, ScreenGroup[]>();
  for (const g of groups) {
    const key = g.parentId && byId.has(g.parentId) ? g.parentId : null;
    kids.set(key, [...(kids.get(key) ?? []), g]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position);
  const order = new Map<string, number>();
  const hidden = new Set<string>();
  const walk = (parent: string | null, parentHidden: boolean) => {
    for (const g of kids.get(parent) ?? []) {
      order.set(g.id, order.size);
      const h = parentHidden || g.hidden;
      if (h) hidden.add(g.id);
      walk(g.id, h);
    }
  };
  walk(null, false);
  const path = (groupId: string | null) => {
    const out: string[] = [];
    for (let g = groupId ? byId.get(groupId) : undefined; g; g = g.parentId ? byId.get(g.parentId) : undefined) out.unshift(g.name);
    return out;
  };
  const descendants = (groupId: string) => {
    const out = new Set<string>([groupId]);
    const stack = [groupId];
    while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) if (!out.has(k.id)) { out.add(k.id); stack.push(k.id); }
    return out;
  };
  return { groups, byId, path, order, descendants, hidden };
}

const iso = (d: Date) => d.toISOString();

@Injectable()
export class ScreensService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  private get screens() {
    return this.ds.getRepository(Screen);
  }

  async groupIndex(projectId: string) {
    return indexGroups(await this.ds.getRepository(ScreenGroup).find({ where: { projectId, missing: false } }));
  }

  async groups(projectId: string): Promise<GroupDto[]> {
    const idx = await this.groupIndex(projectId);
    const counts = await this.screens
      .createQueryBuilder("s")
      .select("s.group_id", "groupId")
      .addSelect("count(*)::int", "n")
      .where("s.project_id = :projectId AND s.missing = false AND s.hidden = false AND s.draft = false AND s.duplicate_of IS NULL", { projectId })
      .groupBy("s.group_id")
      .getRawMany<{ groupId: string | null; n: number }>();
    const n = new Map(counts.map((c) => [c.groupId, c.n]));
    return [...idx.groups]
      .sort((a, b) => (idx.order.get(a.id) ?? 0) - (idx.order.get(b.id) ?? 0))
      .map((g) => ({ id: g.id, parentId: g.parentId, kind: g.kind, name: g.name, position: g.position, hidden: g.hidden, screens: n.get(g.id) ?? 0 }));
  }

  async setGroupHidden(id: string, hidden: boolean): Promise<GroupDto> {
    const repo = this.ds.getRepository(ScreenGroup);
    const g = await repo.findOneBy({ id });
    if (!g) throw new NotFoundException(`group ${id} not found`);
    g.hidden = hidden;
    await repo.save(g);
    return (await this.groups(g.projectId)).find((x) => x.id === id)!;
  }

  async byId(id: string) {
    const s = await this.screens.findOneBy({ id });
    if (!s) throw new NotFoundException(`screen ${id} not found`);
    return s;
  }

  async list(projectId: string, raw: ScreenListQuery): Promise<ScreenPage> {
    const query = ListSchema.parse(raw);
    const idx = await this.groupIndex(projectId);
    const qb = this.screens
      .createQueryBuilder("s")
      .select(["s.id", "s.groupId", "s.position", "s.name"])
      .where("s.project_id = :projectId", { projectId });
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb.andWhere(new Brackets((w) => w.where("s.name ILIKE :like", { like }).orWhere("s.url ILIKE :like", { like })));
    }
    if (query.groupId) qb.andWhere("s.group_id IN (:...groupIds)", { groupIds: [...idx.descendants(query.groupId)] });
    if (query.hasUrl === "yes") qb.andWhere("s.url IS NOT NULL AND s.url <> ''");
    if (query.hasUrl === "no") qb.andWhere("(s.url IS NULL OR s.url = '')");
    const hiddenGroups = [...idx.hidden];
    if (query.hidden === "no") {
      qb.andWhere("s.hidden = false AND s.missing = false");
      if (hiddenGroups.length) qb.andWhere("(s.group_id IS NULL OR s.group_id NOT IN (:...hiddenGroups))", { hiddenGroups });
    } else if (query.hidden === "yes") {
      qb.andWhere(new Brackets((w) => {
        w.where("s.hidden = true").orWhere("s.missing = true");
        if (hiddenGroups.length) w.orWhere("s.group_id IN (:...hiddenGroups)", { hiddenGroups });
      }));
    }
    if (query.drafts === "hide") qb.andWhere("s.draft = false AND s.duplicate_of IS NULL");
    if (query.status) {
      const last = "(SELECT r.status FROM results r WHERE r.screen_id = s.id ORDER BY r.created_at DESC LIMIT 1)";
      if (query.status === "none") qb.andWhere(`${last} IS NULL`);
      else qb.andWhere(`${last} = :status`, { status: query.status });
    }
    const rows = await qb.getMany();
    rows.sort((a, b) => (idx.order.get(a.groupId ?? "") ?? -1) - (idx.order.get(b.groupId ?? "") ?? -1) || a.position - b.position || a.name.localeCompare(b.name));
    const start = (query.page - 1) * query.pageSize;
    const pageIds = rows.slice(start, start + query.pageSize).map((r) => r.id);
    const items = await this.toDtos(pageIds, idx);
    return { items, total: rows.length, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<ScreenDto> {
    const s = await this.byId(id);
    return (await this.toDtos([s.id], await this.groupIndex(s.projectId)))[0]!;
  }

  async update(id: string, body: ScreenUpdate): Promise<ScreenDto> {
    const s = await this.byId(id);
    if (body.url !== undefined) {
      const url = body.url?.trim() || null;
      if (url && /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) throw new BadRequestException("url: http(s) only, or a path of the website");
      if (url && /^https?:\/\//i.test(url)) {
        try { new URL(url); } catch { throw new BadRequestException("url: not a valid URL"); }
      }
      s.url = url;
    }
    if (body.cookies !== undefined) s.cookies = body.cookies;
    if (body.requiresLogin !== undefined) s.requiresLogin = body.requiresLogin;
    if (body.steps !== undefined) s.steps = body.steps;
    if (body.prompt !== undefined) s.prompt = body.prompt?.trim() || null;
    if (body.hidden !== undefined) s.hidden = body.hidden;
    if (body.target !== undefined) s.target = body.target;
    if (body.storyId !== undefined) s.storyId = body.storyId?.trim() || null;
    await this.screens.save(s);
    return this.get(id);
  }

  previewOf(s: Screen): Preview | null {
    const p = s.preview as (Omit<Preview, "screenshotUrl"> & { screenshotKey: string | null }) | null;
    if (!p) return null;
    return { jobId: p.jobId, status: p.status, finalUrl: p.finalUrl, reason: p.reason, screenshotUrl: fileUrl(p.screenshotKey), unmocked: p.unmocked ?? [], at: p.at };
  }

  /** DTOs of screens (in the order of ids) with their design images, mock count and last result. */
  async toDtos(ids: string[], idx: GroupIndex): Promise<ScreenDto[]> {
    if (!ids.length) return [];
    const screens = await this.screens.findBy({ id: In(ids) });
    const revIds = screens.map((s) => s.currentRevisionId).filter((x): x is string => !!x);
    const revs = revIds.length ? await this.ds.getRepository(ScreenRevision).findBy({ id: In(revIds) }) : [];
    const revById = new Map(revs.map((r) => [r.id, r]));
    const mockCounts = await this.ds.getRepository(MockRoute)
      .createQueryBuilder("m").select("m.screen_id", "screenId").addSelect("count(*)::int", "n")
      .where("m.screen_id IN (:...ids)", { ids }).groupBy("m.screen_id").getRawMany<{ screenId: string; n: number }>();
    const mocks = new Map(mockCounts.map((m) => [m.screenId, m.n]));
    const lasts = await this.ds.getRepository(Result).query(
      `SELECT DISTINCT ON (screen_id) id, run_id, screen_id, status, coverage, design_score, created_at
         FROM results WHERE screen_id = ANY($1) ORDER BY screen_id, created_at DESC`, [ids],
    ) as { id: string; run_id: string; screen_id: string; status: ResultStatus; coverage: number | null; design_score: number | null; created_at: Date }[];
    const last = new Map(lasts.map((r) => [r.screen_id, r]));
    const byId = new Map(screens.map((s) => [s.id, s]));
    return ids.map((id) => byId.get(id)).filter((s): s is Screen => !!s).map((s) => {
      const rev = s.currentRevisionId ? revById.get(s.currentRevisionId) : undefined;
      const r = last.get(s.id);
      return {
        id: s.id,
        groupId: s.groupId,
        groupPath: idx.path(s.groupId),
        figmaNodeId: s.figmaNodeId,
        name: s.name,
        position: s.position,
        width: s.width,
        height: s.height,
        designHeight: s.designHeight,
        viewport: { w: s.viewportW, h: s.viewportH },
        scrolls: s.scrolls,
        draft: s.draft,
        duplicateOf: s.duplicateOf,
        hidden: s.hidden || (s.groupId ? idx.hidden.has(s.groupId) : false),
        missing: s.missing,
        url: s.url,
        cookies: s.cookies as ScreenDto["cookies"],
        requiresLogin: s.requiresLogin,
        steps: s.steps as ScreenDto["steps"],
        prompt: s.prompt,
        target: s.target,
        storyId: s.storyId,
        imageUrl: fileUrl(rev?.imageKey),
        thumbUrl: fileUrl(rev?.thumbKey ?? rev?.imageKey),
        mocks: mocks.get(s.id) ?? 0,
        lastResult: r
          ? { id: r.id, runId: r.run_id, status: r.status, coverage: r.coverage, designScore: r.design_score, at: iso(new Date(r.created_at)) }
          : null,
        updatedAt: iso(s.updatedAt),
      };
    });
  }
}
