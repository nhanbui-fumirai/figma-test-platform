/**
 * Mocks of a screen. The recorded body never changes; an edit (hand or AI) is a list of ops, and the served body is
 * recomputed with the guards (value kinds, distinct list items) on every change: refused ops are listed, not applied.
 */
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MockOp, MockRoute as MockDto, MockRouteCreate, MockRouteSummary, MockRouteUpdate } from "@figtest/contracts";
import { MockRouteCreate as CreateSchema } from "@figtest/contracts";
import { MockRoute, Screen } from "@figtest/db";
import { applyOpsChecked } from "@figtest/mocks";
import type { DataSource } from "typeorm";
import { DATA_SOURCE } from "../../infra/tokens";

export const toSummary = (m: MockRoute): MockRouteSummary => ({
  id: m.id, screenId: m.screenId, method: m.method, host: m.host, path: m.path, query: m.query ?? {}, operationName: m.operationName,
  status: m.status, contentType: m.contentType, origin: m.origin, enabled: m.enabled, ops: (m.ops ?? []).length, updatedAt: m.updatedAt.toISOString(),
});

export const toDto = (m: MockRoute): MockDto => ({
  ...toSummary(m), variables: m.variables ?? null, recordedBody: m.recordedBody ?? null, opsList: (m.ops ?? []) as MockOp[], body: m.body ?? null,
  violations: m.violations ?? [],
});

@Injectable()
export class MocksService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  private get repo() {
    return this.ds.getRepository(MockRoute);
  }

  async screen(id: string) {
    const s = await this.ds.getRepository(Screen).findOneBy({ id });
    if (!s) throw new NotFoundException(`screen ${id} not found`);
    return s;
  }

  async byId(id: string) {
    const m = await this.repo.findOneBy({ id });
    if (!m) throw new NotFoundException(`mock ${id} not found`);
    return m;
  }

  async list(screenId: string) {
    await this.screen(screenId);
    return (await this.repo.find({ where: { screenId }, order: { host: "ASC", path: "ASC", operationName: "ASC" } })).map(toSummary);
  }

  async create(screenId: string, raw: MockRouteCreate) {
    await this.screen(screenId);
    const body = CreateSchema.parse(raw);
    const u = new URL(body.url);
    const row = await this.repo.save(this.repo.create({
      screenId, method: body.method, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), operationName: null, variables: null,
      status: body.status, contentType: body.contentType, recordedBody: body.body ?? null, ops: [], body: body.body ?? null, violations: [], origin: "manual", enabled: true,
    }));
    return toDto(row);
  }

  async update(id: string, body: MockRouteUpdate, origin?: MockRoute["origin"]) {
    const m = await this.byId(id);
    if (body.enabled !== undefined) m.enabled = body.enabled;
    if (body.status !== undefined) m.status = body.status;
    if (body.ops !== undefined) {
      const r = applyOpsChecked(m.recordedBody ?? null, body.ops);
      m.ops = body.ops;
      m.body = r.body;
      m.violations = r.violations;
      m.origin = origin ?? (body.ops.length ? "manual" : m.origin === "manual" ? "recorded" : m.origin);
    }
    return toDto(await this.repo.save(m));
  }

  async remove(id: string) {
    await this.repo.delete({ id: (await this.byId(id)).id });
  }
}
