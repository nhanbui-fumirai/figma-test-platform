import type { MigrationInterface, QueryRunner } from "typeorm";

/** M0: users, sessions, projects, credentials, jobs, job logs. */
export class Init1762790000000 implements MigrationInterface {
  name = "Init1762790000000";

  async up(q: QueryRunner) {
    await q.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        password_hash text NOT NULL,
        role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email ON users (email);

      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash);
      CREATE INDEX sessions_expires_at ON sessions (expires_at);

      CREATE TABLE projects (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL,
        base_url text NOT NULL,
        settings jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
      CREATE UNIQUE INDEX projects_slug ON projects (slug) WHERE deleted_at IS NULL;

      CREATE TABLE credentials (
        id uuid PRIMARY KEY,
        project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL,
        ciphertext text NOT NULL,
        iv text NOT NULL,
        tag text NOT NULL,
        key_version int NOT NULL,
        hint text NOT NULL DEFAULT '',
        meta jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- one secret of a kind per project, and one platform-wide (project_id null)
      CREATE UNIQUE INDEX credentials_project_kind ON credentials (project_id, kind) NULLS NOT DISTINCT;

      CREATE TABLE jobs (
        id uuid PRIMARY KEY,
        project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        total int NOT NULL DEFAULT 0,
        done int NOT NULL DEFAULT 0,
        payload jsonb NOT NULL DEFAULT '{}',
        error text,
        cancel_requested boolean NOT NULL DEFAULT false,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        ended_at timestamptz
      );
      CREATE INDEX jobs_project_created ON jobs (project_id, created_at DESC);

      CREATE TABLE job_logs (
        id bigserial PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        screen_id uuid,
        level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        message text NOT NULL,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX job_logs_job_id ON job_logs (job_id, id);
    `);
  }

  async down(q: QueryRunner) {
    await q.query("DROP TABLE job_logs; DROP TABLE jobs; DROP TABLE credentials; DROP TABLE projects; DROP TABLE sessions; DROP TABLE users;");
  }
}
