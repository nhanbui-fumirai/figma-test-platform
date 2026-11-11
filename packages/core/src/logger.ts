/** pino logger whose every argument goes through redactDeep: a registered secret is never written. */
import pino, { type Logger } from "pino";
import { redactDeep } from "./redact";

export type { Logger };

export function createLogger(name: string, level = process.env.LOG_LEVEL || "info"): Logger {
  return pino({
    name,
    level,
    // the usual places a secret travels in an object
    redact: { paths: ["password", "token", "*.password", "*.token", "headers.authorization", "headers.cookie"], censor: "***" },
    hooks: {
      logMethod(args, method) {
        return method.apply(this, args.map((a) => redactDeep(a)) as Parameters<typeof method>);
      },
    },
  });
}
