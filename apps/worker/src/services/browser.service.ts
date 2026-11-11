/**
 * One Chromium per worker process, launched on first use and again if it crashed; every job gets its own context
 * (isolated cookies and storage). The URL policy comes from ALLOW_PRIVATE_HOSTS.
 */
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { launchBrowser, type Browser, type UrlPolicy } from "@figtest/browser";
import type { Env } from "@figtest/core";
import { ENV } from "../tokens";

@Injectable()
export class BrowserService implements OnApplicationShutdown {
  private browser: Promise<Browser> | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get policy(): UrlPolicy {
    return { allowPrivateHosts: this.env.ALLOW_PRIVATE_HOSTS };
  }

  async get(): Promise<Browser> {
    if (this.browser) {
      const b = await this.browser.catch(() => null);
      if (b?.isConnected()) return b;
    }
    this.browser = launchBrowser();
    return this.browser;
  }

  async onApplicationShutdown() {
    const b = await this.browser?.catch(() => null);
    await b?.close().catch(() => {});
  }
}
