/**
 * The design of a screen as the jobs need it: its current spec and image from the blob store, its texts in reading order
 * (AI prompts), a downscaled image for the AI, and the AI settings of the project with an AiCall row per call.
 */
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { AiConfig, AiUsage } from "@figtest/ai";
import { ProjectSettings } from "@figtest/contracts";
import { gunzipJson, type BlobStore } from "@figtest/core";
import { AiCall, ScreenRevision, type CredentialStore, type Project, type Screen } from "@figtest/db";
import { makeThumbnail, type DesignSpec } from "@figtest/figma";
import type { DataSource } from "typeorm";
import { BLOB, CREDENTIALS, DATA_SOURCE } from "../tokens";

@Injectable()
export class DesignService {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(BLOB) private readonly blob: BlobStore,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
  ) {}

  async revision(revisionId: string | null) {
    return revisionId ? this.ds.getRepository(ScreenRevision).findOneBy({ id: revisionId }) : null;
  }

  async spec(rev: ScreenRevision): Promise<DesignSpec> {
    return gunzipJson<DesignSpec>(await this.blob.get(rev.specKey));
  }

  /** texts of the design from top to bottom, left to right */
  texts(spec: DesignSpec) {
    return spec.nodes
      .filter((n) => n.text?.characters.trim())
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
      .map((n) => n.text!.characters.trim());
  }

  /** the design image for an AI prompt: at most 1000 px wide */
  async imageForAi(rev: ScreenRevision): Promise<Buffer | null> {
    if (!rev.imageKey || !(await this.blob.exists(rev.imageKey))) return null;
    const png = await this.blob.get(rev.imageKey);
    return makeThumbnail(png, 1000).catch(() => null);
  }

  async aiConfig(project: Project): Promise<AiConfig> {
    const settings = ProjectSettings.parse(project.settings ?? {});
    const key = await this.credentials.get(project.id, "ai_key");
    if (!settings.ai || !key) throw new BadRequestException("the project has no AI provider / key");
    return { provider: settings.ai.provider, model: settings.ai.model, apiKey: key };
  }

  usageLogger(projectId: string, jobId: string, purpose: string) {
    return async (u: AiUsage) => {
      await this.ds.getRepository(AiCall).insert({
        projectId, jobId, purpose, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, ok: u.ok,
      });
    };
  }

  async screenOrThrow(screen: Screen | null) {
    if (!screen) throw new Error("screen not found (deleted?)");
    return screen;
  }
}
