import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Me } from "@figtest/contracts";

export const PUBLIC = "public";
/** A route reachable without a session (login, health). */
export const Public = () => SetMetadata(PUBLIC, true);

export type AuthedRequest = { user?: Me; sessionId?: string; cookies: Record<string, string> };

/** The signed-in user of the request (set by SessionGuard). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user);
