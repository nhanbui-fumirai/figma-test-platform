/**
 * Every route needs a session, except the ones marked @Public(). A request that changes something (not GET/HEAD) from a
 * browser must come from the web app (Origin = WEB_ORIGIN): another site cannot use the session cookie (CSRF).
 */
import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Env } from "@figtest/core";
import type { Request } from "express";
import { ENV } from "../../infra/tokens";
import { type AuthedRequest, PUBLIC } from "./auth.decorators";
import { AuthService, SESSION_COOKIE } from "./auth.service";

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<Request & AuthedRequest>();
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== this.env.WEB_ORIGIN) throw new ForbiddenException("requests that change data come from the web app only");
    }
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const user = await this.auth.userOf(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new UnauthorizedException("sign in first");
    req.user = user;
    return true;
  }
}
