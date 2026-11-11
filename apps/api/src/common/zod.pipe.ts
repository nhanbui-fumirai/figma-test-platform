import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

/** Validates a body / query / param with a schema of @figtest/contracts; 400 with every problem otherwise. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw new BadRequestException({
      message: r.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "),
      details: r.error.issues,
    });
  }
}
