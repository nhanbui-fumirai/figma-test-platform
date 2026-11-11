/**
 * Secrets of a project (Figma / GitHub tokens, test login, AI key), sealed with APP_SECRET. The api writes them and
 * shows only their hint; the worker reads them for the job that needs them. Every value read is registered for
 * redaction, so it never reaches a log line.
 */
import { hintOf, registerSecret, seal, unseal } from "@figtest/core";
import type { DataSource } from "typeorm";
import { Credential, type CredentialKind } from "./entities/project.entity";

export class CredentialStore {
  constructor(private readonly ds: DataSource, private readonly appSecret: string) {}

  private get repo() {
    return this.ds.getRepository(Credential);
  }

  list(projectId: string) {
    return this.repo.find({ where: { projectId }, order: { kind: "ASC" } });
  }

  /** Stores (or replaces) the secret of a kind. `value` is a token, or JSON for a test login. */
  async put(projectId: string, kind: CredentialKind, value: string, meta: Record<string, unknown> = {}, hint = hintOf(value)) {
    const sealed = seal(value, this.appSecret);
    const existing = await this.repo.findOneBy({ projectId, kind });
    const row = existing ?? this.repo.create({ projectId, kind });
    Object.assign(row, sealed, { hint, meta });
    return this.repo.save(row);
  }

  async remove(projectId: string, kind: CredentialKind) {
    await this.repo.delete({ projectId, kind });
  }

  /** The plain secret, or null when there is none. */
  async get(projectId: string, kind: CredentialKind): Promise<string | null> {
    const row = await this.repo.findOneBy({ projectId, kind });
    if (!row) return null;
    const value = unseal(row, this.appSecret);
    registerSecret(value);
    if (kind === "test_login") {
      try {
        const parsed = JSON.parse(value) as { password?: string };
        registerSecret(parsed.password);
      } catch {
        /* not JSON: registered as a whole */
      }
    }
    return value;
  }

  async has(projectId: string, kind: CredentialKind) {
    return this.repo.existsBy({ projectId, kind });
  }
}
