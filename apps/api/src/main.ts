import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { loadEnv } from "@figtest/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  // the web app calls the api directly (no proxy: uploads and SSE are not buffered), with its session cookie
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  console.log(`api on http://localhost:${env.API_PORT}/api (web: ${env.WEB_ORIGIN})`);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
