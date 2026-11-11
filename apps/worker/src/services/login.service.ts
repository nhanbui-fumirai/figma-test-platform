/**
 * The logged-in state of a project test account: made once with @figtest/browser login() (the password is only typed on
 * the site host), sealed in login_sessions and reused until it expires or the test login changes. One login at a time per
 * project in this process, so the screens of a run do not all log in together.
 */
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { TestLogin } from "@figtest/contracts";
import { login, newContext, type LogFn, type StorageState } from "@figtest/browser";
import { seal, sha256, unseal, type Env } from "@figtest/core";
import { LoginSession, type CredentialStore, type Project } from "@figtest/db";
import type { DataSource } from "typeorm";
import { CREDENTIALS, DATA_SOURCE, ENV } from "../tokens";
import { BrowserService } from "./browser.service";

const TTL_MS = 30 * 60 * 1000;

@Injectable()
export class LoginService {
  private pending = new Map<string, Promise<StorageState>>();

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
    @Inject(ENV) private readonly env: Env,
    private readonly browsers: BrowserService,
  ) {}

  stateFor(project: Project, log: LogFn): Promise<StorageState> {
    const running = this.pending.get(project.id);
    if (running) return running;
    const p = this.make(project, log).finally(() => this.pending.delete(project.id));
    this.pending.set(project.id, p);
    return p;
  }

  /** forget the saved state (the site logged us out) */
  async forget(projectId: string) {
    await this.ds.getRepository(LoginSession).delete({ projectId });
  }

  private async make(project: Project, log: LogFn): Promise<StorageState> {
    const raw = await this.credentials.get(project.id, "test_login");
    if (!raw) throw new BadRequestException("this screen needs a login: add the test login in the project settings");
    const creds = TestLogin.parse(JSON.parse(raw));
    const hash = sha256(raw);
    const repo = this.ds.getRepository(LoginSession);
    const saved = await repo.findOneBy({ projectId: project.id });
    if (saved && saved.credentialHash === hash && saved.expiresAt.getTime() > Date.now()) {
      return JSON.parse(unseal(saved, this.env.APP_SECRET)) as StorageState;
    }
    await log(`logging in with the test account on ${new URL(creds.loginUrl).host}`);
    const browser = await this.browsers.get();
    const context = await newContext(browser, { viewport: { w: 1280, h: 900 }, cookieUrl: creds.loginUrl, policy: this.browsers.policy });
    try {
      const state = await login(context, creds, project.baseUrl, { policy: this.browsers.policy, log });
      const row = saved ?? repo.create({ projectId: project.id });
      Object.assign(row, seal(JSON.stringify(state), this.env.APP_SECRET), { credentialHash: hash, expiresAt: new Date(Date.now() + TTL_MS) });
      await repo.save(row);
      await log("logged in");
      return state;
    } finally {
      await context.close().catch(() => {});
    }
  }
}
