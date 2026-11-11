/**
 * Every error answers { statusCode, message, details? } (contracts ApiErrorBody). A unique-index violation is a 409; an
 * unexpected error is logged and answered 500 without its internals.
 */
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { Logger } from "@figtest/core";
import type { Response } from "express";
import { QueryFailedError } from "typeorm";
import { LOGGER } from "../infra/tokens";

@Catch()
export class ErrorsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly log: Logger) {}

  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    if (error instanceof HttpException) {
      const body = error.getResponse();
      const obj = typeof body === "string" ? { message: body } : (body as Record<string, unknown>);
      res.status(error.getStatus()).json({ statusCode: error.getStatus(), message: String(obj.message ?? error.message), details: obj.details });
      return;
    }
    if (error instanceof QueryFailedError && (error as QueryFailedError & { code?: string }).code === "23505") {
      res.status(409).json({ statusCode: 409, message: "already exists" });
      return;
    }
    this.log.error({ err: error }, "unexpected error");
    res.status(500).json({ statusCode: 500, message: "internal error" });
  }
}
