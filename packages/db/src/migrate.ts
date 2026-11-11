/** pnpm db:migrate: applies the migrations not applied yet to DATABASE_URL. */
import { createLogger, loadEnv } from "@figtest/core";
import { createDataSource } from "./data-source";

async function main() {
  const env = loadEnv();
  const log = createLogger("migrate", env.LOG_LEVEL);
  const ds = await createDataSource(env.DATABASE_URL).initialize();
  try {
    const done = await ds.runMigrations({ transaction: "each" });
    log.info(done.length ? `applied: ${done.map((m) => m.name).join(", ")}` : "database up to date");
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
