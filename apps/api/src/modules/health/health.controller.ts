import { Controller, Get, Inject } from "@nestjs/common";
import type { DataSource } from "typeorm";
import { DATA_SOURCE } from "../../infra/tokens";
import { Public } from "../auth/auth.decorators";

@Controller("health")
export class HealthController {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  @Public()
  @Get()
  async health() {
    await this.ds.query("SELECT 1");
    return { ok: true };
  }
}
