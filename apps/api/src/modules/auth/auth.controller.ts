import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { LoginRequest, type Me } from "@figtest/contracts";
import type { Env } from "@figtest/core";
import type { Request, Response } from "express";
import { ZodPipe } from "../../common/zod.pipe";
import { ENV } from "../../infra/tokens";
import { CurrentUser, Public } from "./auth.decorators";
import { AuthService, SESSION_COOKIE, SESSION_DAYS } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginRequest)) body: LoginRequest, @Res({ passthrough: true }) res: Response): Promise<Me> {
    const { me, token } = await this.auth.login(body.email, body.password);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_DAYS * 24 * 3600_000,
    });
    return me;
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  @Get("me")
  me(@CurrentUser() me: Me): Me {
    return me;
  }
}
