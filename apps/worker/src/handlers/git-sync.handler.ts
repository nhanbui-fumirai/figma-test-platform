/**
 * git.sync: clones (bare, shallow, one branch) or fetches the read-only copy of the project repository. The token is the
 * project github_token credential, given to git only through its environment (@figtest/git).
 */
import { Inject, Injectable } from "@nestjs/common";
import { repoDir, type Env, type QueuePayload } from "@figtest/core";
import { Repository, type CredentialStore } from "@figtest/db";
import { syncRepository } from "@figtest/git";
import type { DataSource } from "typeorm";
import type { JobContext, JobHandler } from "../job-handler";
import { CREDENTIALS, DATA_SOURCE, ENV } from "../tokens";

@Injectable()
export class GitSyncHandler implements JobHandler<"git.sync"> {
  readonly queue = "git.sync" as const;
  readonly concurrency = 1;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async run({ projectId }: QueuePayload<"git.sync">, ctx: JobContext) {
    const repos = this.ds.getRepository(Repository);
    const repo = await repos.findOneByOrFail({ projectId });
    try {
      const token = await this.credentials.get(projectId, "github_token");
      await ctx.log(`sync ${repo.url} (${repo.branch})${token ? " with the project token" : " without a token (public repository)"}`);
      const { headSha } = await syncRepository(repoDir(this.env.STORAGE_PATH, projectId), { url: repo.url, branch: repo.branch, token }, { log: (m) => ctx.log(m) });
      await repos.update({ id: repo.id }, { status: "ready", headSha, lastSyncedAt: new Date(), error: null });
      await ctx.log(`synced at ${headSha.slice(0, 10)}`);
    } catch (e) {
      await repos.update({ id: repo.id }, { status: "failed", error: (e as Error).message.slice(0, 1000) });
      throw e;
    }
  }
}
