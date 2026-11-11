import "reflect-metadata";
import { DataSource } from "typeorm";
import { Job, JobLog } from "./entities/job.entity";
import { Credential, Project } from "./entities/project.entity";
import { Session, User } from "./entities/user.entity";
import { FigmaImport, Screen, ScreenGroup, ScreenRevision } from "./entities/design.entity";
import { AiCall, LoginSession, MockRoute, Repository, Result, Run } from "./entities/run.entity";
import { Init1762790000000 } from "./migrations/1762790000000-init";
import { Features1762800000000 } from "./migrations/1762800000000-features";

export const ENTITIES = [
  User, Session, Project, Credential, Job, JobLog,
  FigmaImport, ScreenGroup, Screen, ScreenRevision, Run, Result, MockRoute, LoginSession, Repository, AiCall,
];
export const MIGRATIONS = [Init1762790000000, Features1762800000000];

/**
 * The database of the platform. The schema only changes through migrations (synchronize stays off); pg-boss keeps its
 * own schema (pgboss) and creates it itself.
 */
export function createDataSource(url: string, opts: { logging?: boolean; poolSize?: number } = {}) {
  return new DataSource({
    type: "postgres",
    url,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
    logging: opts.logging ?? false,
    extra: { max: opts.poolSize ?? 10 },
  });
}
