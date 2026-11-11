/**
 * figma.import: reads the design (.fig from the blob store, or the REST API with the project token), updates the pages,
 * sections and screens (matched by Figma node id, so their config survives a re-import), and renders only the frames
 * whose content hash changed: a new revision for them, the others keep theirs.
 */
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Inject, Injectable } from "@nestjs/common";
import { blobKeys, gzipJson, tmpDir, type BlobStore, type Env, type QueuePayload } from "@figtest/core";
import {
  FigmaImport, Screen, ScreenGroup, ScreenRevision, newId, type CredentialStore,
} from "@figtest/db";
import {
  extractSpec, FrameRenderer, listDesign, makeThumbnail, readFigFile, readFigmaFile, type DesignDocument,
} from "@figtest/figma";
import { In, type DataSource } from "typeorm";
import { JobCancelled, type JobContext, type JobHandler } from "../job-handler";
import { BrowserService } from "../services/browser.service";
import { BLOB, CREDENTIALS, DATA_SOURCE, ENV } from "../tokens";

@Injectable()
export class FigmaImportHandler implements JobHandler<"figma.import"> {
  readonly queue = "figma.import" as const;
  readonly concurrency = 1;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(BLOB) private readonly blob: BlobStore,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
    @Inject(ENV) private readonly env: Env,
    private readonly browsers: BrowserService,
  ) {}

  async run({ importId }: QueuePayload<"figma.import">, ctx: JobContext) {
    const imports = this.ds.getRepository(FigmaImport);
    const imp = await imports.findOneByOrFail({ id: importId });
    const projectId = imp.projectId;
    let tmp: string | null = null;
    try {
      // ---- read
      let doc: DesignDocument;
      if (imp.source === "fig") {
        await ctx.log(`reading ${imp.fileName}`);
        tmp = path.join(tmpDir(this.env.STORAGE_PATH), `${imp.id}.fig`);
        await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
        await pipeline(this.blob.stream(imp.blobKey!), fs.createWriteStream(tmp));
        doc = await readFigFile(tmp);
      } else {
        const token = await this.credentials.get(projectId, "figma_token");
        if (!token) throw new Error("the project has no Figma access token");
        await ctx.log(`reading Figma file ${imp.fileKey}${imp.nodeId ? ` (node ${imp.nodeId})` : ""}`);
        doc = await readFigmaFile(imp.fileKey!, { token, nodeId: imp.nodeId, log: (m) => void ctx.log(m) });
      }
      const { groups, frames } = listDesign(doc);
      const partial = imp.source === "rest" && !!imp.nodeId;
      await ctx.log(`${groups.filter((g) => g.kind === "page").length} page(s), ${groups.filter((g) => g.kind === "section").length} section(s), ${frames.length} frame(s)`);
      if (await ctx.cancelled()) throw new JobCancelled();

      // ---- groups, by node id: rows first, then their parents (any order of listDesign works)
      const groupRepo = this.ds.getRepository(ScreenGroup);
      const existingGroups = await groupRepo.findBy({ projectId });
      const groupByNode = new Map(existingGroups.map((g) => [g.figmaNodeId, g]));
      for (const g of groups) {
        const row = groupByNode.get(g.nodeId) ?? groupRepo.create({ id: newId(), projectId, figmaNodeId: g.nodeId, hidden: false, parentId: null });
        Object.assign(row, { kind: g.kind, name: g.name, position: g.position, missing: false });
        groupByNode.set(g.nodeId, await groupRepo.save(row));
      }
      for (const g of groups) {
        const row = groupByNode.get(g.nodeId)!;
        const parentId = g.parentNodeId ? (groupByNode.get(g.parentNodeId)?.id ?? null) : null;
        if (row.parentId !== parentId) await groupRepo.update({ id: row.id }, { parentId });
      }
      if (!partial) {
        const seen = new Set(groups.map((g) => g.nodeId));
        const gone = existingGroups.filter((g) => !seen.has(g.figmaNodeId) && !g.missing).map((g) => g.id);
        if (gone.length) await groupRepo.update({ id: In(gone) }, { missing: true });
      }

      // ---- screens, by node id: their config (URL, cookies, steps, mocks) stays
      const screenRepo = this.ds.getRepository(Screen);
      const existing = await screenRepo.findBy({ projectId });
      const screenByNode = new Map(existing.map((s) => [s.figmaNodeId, s]));
      const revIds = existing.map((s) => s.currentRevisionId).filter((x): x is string => !!x);
      const revs = revIds.length ? await this.ds.getRepository(ScreenRevision).findBy({ id: In(revIds) }) : [];
      const revById = new Map(revs.map((r) => [r.id, r]));
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      const changed: { screen: Screen; frame: (typeof frames)[number] }[] = [];
      for (const f of frames) {
        let s = screenByNode.get(f.nodeId);
        if (!s) {
          s = screenRepo.create({ id: newId(), projectId, figmaNodeId: f.nodeId, cookies: [], steps: [], requiresLogin: false, hidden: false, target: "site" });
          created++;
        }
        Object.assign(s, {
          groupId: groupByNode.get(f.groupNodeId)?.id ?? null, name: f.name, position: f.position, width: f.width, height: f.height,
          designHeight: f.designHeight, viewportW: Math.round(f.viewport.w), viewportH: Math.round(f.viewport.h), scrolls: f.scrolls,
          draft: f.draft, duplicateOf: f.duplicateOf, missing: false,
        });
        s = await screenRepo.save(s);
        screenByNode.set(f.nodeId, s);
        const rev = s.currentRevisionId ? revById.get(s.currentRevisionId) : undefined;
        if (rev && rev.contentHash === f.contentHash && rev.imageKey) unchanged++;
        else {
          if (rev) updated++;
          changed.push({ screen: s, frame: f });
        }
      }
      let removed = 0;
      if (!partial) {
        const seen = new Set(frames.map((f) => f.nodeId));
        const gone = existing.filter((s) => !seen.has(s.figmaNodeId) && !s.missing).map((s) => s.id);
        removed = gone.length;
        if (gone.length) await screenRepo.update({ id: In(gone) }, { missing: true });
      }
      await ctx.log(`${created} new, ${updated} changed, ${unchanged} unchanged, ${removed} gone from the design`);

      // ---- render the new / changed frames
      await ctx.progress(0, changed.length);
      let rendered = 0;
      let renderFailed = 0;
      const renderer = await FrameRenderer.launch({ browser: await this.browsers.get() });
      try {
        for (const [i, { screen, frame }] of changed.entries()) {
          if (await ctx.cancelled()) throw new JobCancelled();
          const revId = newId();
          const keys = blobKeys.revision(projectId, screen.id, revId);
          const spec = extractSpec(doc, frame);
          await this.blob.put(keys.spec, await gzipJson(spec));
          let imageKey: string | null = null;
          let thumbKey: string | null = null;
          try {
            const out = await renderer.render(doc, frame);
            await this.blob.put(keys.image, out.png);
            await this.blob.put(keys.thumb, await makeThumbnail(out.png, 320));
            imageKey = keys.image;
            thumbKey = keys.thumb;
            rendered++;
            for (const w of out.warnings.slice(0, 3)) await ctx.log(`${frame.name}: ${w}`, "warn", screen.id);
          } catch (e) {
            renderFailed++;
            await ctx.log(`${frame.name}: not rendered (${(e as Error).message})`, "warn", screen.id);
          }
          const rev = await this.ds.getRepository(ScreenRevision).save(this.ds.getRepository(ScreenRevision).create({
            id: revId, screenId: screen.id, importId: imp.id, contentHash: frame.contentHash, imageKey, thumbKey, specKey: keys.spec,
            texts: spec.nodes.filter((n) => n.text).length,
          }));
          await screenRepo.update({ id: screen.id }, { currentRevisionId: rev.id });
          await ctx.progress(i + 1, changed.length);
          if ((i + 1) % 10 === 0 || i + 1 === changed.length) await ctx.log(`rendered ${i + 1}/${changed.length}`);
        }
      } finally {
        await renderer.close();
      }
      const stats = {
        pages: groups.filter((g) => g.kind === "page").length, sections: groups.filter((g) => g.kind === "section").length, frames: frames.length,
        created, updated, unchanged, removed, rendered, renderFailed,
      };
      await imports.update({ id: imp.id }, { stats });
      await ctx.log(`import done: ${rendered} frame(s) rendered${renderFailed ? `, ${renderFailed} failed` : ""}`);
    } finally {
      if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
}
