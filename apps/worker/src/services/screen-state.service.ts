/**
 * Opens the page of a screen in the state of its design, the same way for a preview, a test, a recording and the AI:
 * viewport of the frame, cookies, the test login state, the mocks (replayed or recorded), the steps, settle, then the
 * auth-wall check. A Storybook target opens the story iframe as is (the story brings its own data).
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  detectAuthWall, newContext, openPage, runSteps, settle, type BrowserContext, type Cookie, type LogFn, type Page, type Step,
} from "@figtest/browser";
import { ProjectSettings } from "@figtest/contracts";
import { MockRoute, type Project, type Screen } from "@figtest/db";
import { installMocks, startRecording, type Recorder } from "@figtest/mocks";
import type { DataSource } from "typeorm";
import { DATA_SOURCE } from "../tokens";
import { BrowserService } from "./browser.service";
import { LoginService } from "./login.service";

export const resolveUrl = (baseUrl: string, url: string) => (/^https?:\/\//i.test(url) ? url : `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`);

export interface OpenOptions {
  /** replay the enabled mocks of the screen (default), or none (live API) */
  mocks: "replay" | "none";
  /** run the steps of the screen (default true) */
  steps?: boolean;
  /** record the API calls while the page opens and the steps run */
  record?: boolean;
  /** the URL to open (a result keeps the URL it was queued with) */
  url?: string;
}

export interface OpenedScreen {
  context: BrowserContext;
  page: Page;
  url: string;
  finalUrl: string;
  status: number | null;
  blocked: boolean;
  reason: string | null;
  unmocked: string[];
  recorder: Recorder | null;
  close(): Promise<void>;
}

@Injectable()
export class ScreenStateService {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly browsers: BrowserService,
    private readonly logins: LoginService,
  ) {}

  urlOf(project: Project, screen: Screen) {
    if (screen.target === "storybook") {
      if (!project.storybookUrl || !screen.storyId) throw new Error("a Storybook screen needs the Storybook URL of the project and a story id");
      return `${project.storybookUrl}/iframe.html?id=${encodeURIComponent(screen.storyId)}&viewMode=story`;
    }
    if (!screen.url) throw new Error("the screen has no URL");
    return resolveUrl(project.baseUrl, screen.url);
  }

  async open(project: Project, screen: Screen, opts: OpenOptions, log: LogFn): Promise<OpenedScreen> {
    const url = opts.url ?? this.urlOf(project, screen);
    const story = screen.target === "storybook";
    const settings = ProjectSettings.parse(project.settings ?? {});
    const siteHost = new URL(url).host;
    const storageState = !story && screen.requiresLogin ? await this.logins.stateFor(project, log) : undefined;
    const browser = await this.browsers.get();
    const context = await newContext(browser, {
      viewport: { w: screen.viewportW, h: screen.viewportH },
      cookies: story ? [] : (screen.cookies as Cookie[]),
      cookieUrl: url,
      storageState,
      policy: this.browsers.policy,
    });
    const unmocked: string[] = [];
    let recorder: Recorder | null = null;
    try {
      if (!story && opts.mocks === "replay") {
        const rows = await this.ds.getRepository(MockRoute).findBy({ screenId: screen.id, enabled: true });
        if (rows.length) {
          await installMocks(context, rows.map((r) => ({
            id: r.id, method: r.method, host: r.host, path: r.path, query: r.query ?? {}, operationName: r.operationName, variables: r.variables ?? null,
            status: r.status, contentType: r.contentType, body: r.body,
          })), { include: settings.apiInclude, siteHost, onUnmatched: (d) => unmocked.push(d) });
          await log(`${rows.length} mock(s) served`);
        }
      }
      if (!story && opts.record) recorder = await startRecording(context, { include: settings.apiInclude, siteHost });
      const page = await context.newPage();
      await log(`open ${url} (${screen.viewportW}×${screen.viewportH})`);
      const opened = await openPage(page, url, this.browsers.policy);
      const steps = (screen.steps ?? []) as Step[];
      if (!story && opts.steps !== false && steps.length) {
        await log(`${steps.length} step(s)`);
        await runSteps(page, steps, { baseUrl: url, policy: this.browsers.policy, log });
        await settle(page);
      }
      const wall = await detectAuthWall(page, url);
      if (wall.blocked && screen.requiresLogin) await this.logins.forget(project.id); // stale session: log in again next time
      return {
        context, page, url, finalUrl: page.url() || opened.finalUrl, status: opened.status, blocked: wall.blocked, reason: wall.reason, unmocked, recorder,
        close: () => context.close().catch(() => {}),
      };
    } catch (e) {
      await context.close().catch(() => {});
      throw e;
    }
  }
}
