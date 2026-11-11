import type { MigrationInterface, QueryRunner } from "typeorm";

/** M1-M7: Figma imports, pages/sections, screens and their revisions, runs and results, mocks, login sessions, repository, AI calls. */
export class Features1762800000000 implements MigrationInterface {
  name = "Features1762800000000";

  async up(q: QueryRunner) {
    await q.query(`
      -- search of screens by name / URL (pg_trgm is a trusted extension: the database owner may create it)
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      ALTER TABLE projects ADD COLUMN storybook_url text;

      CREATE TABLE figma_imports (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source text NOT NULL CHECK (source IN ('fig', 'rest')),
        file_name text NOT NULL,
        file_key text,
        node_id text,
        blob_key text,
        job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
        stats jsonb,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX figma_imports_project ON figma_imports (project_id, created_at DESC);

      CREATE TABLE screen_groups (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id uuid REFERENCES screen_groups(id) ON DELETE SET NULL,
        figma_node_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('page', 'section')),
        name text NOT NULL,
        position int NOT NULL DEFAULT 0,
        hidden boolean NOT NULL DEFAULT false,
        missing boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX screen_groups_node ON screen_groups (project_id, figma_node_id);

      CREATE TABLE screens (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        group_id uuid REFERENCES screen_groups(id) ON DELETE SET NULL,
        figma_node_id text NOT NULL,
        name text NOT NULL,
        position int NOT NULL DEFAULT 0,
        width real NOT NULL,
        height real NOT NULL,
        design_height real NOT NULL,
        viewport_w int NOT NULL,
        viewport_h int NOT NULL,
        scrolls boolean NOT NULL DEFAULT false,
        draft boolean NOT NULL DEFAULT false,
        duplicate_of text,
        hidden boolean NOT NULL DEFAULT false,
        missing boolean NOT NULL DEFAULT false,
        url text,
        cookies jsonb NOT NULL DEFAULT '[]',
        requires_login boolean NOT NULL DEFAULT false,
        steps jsonb NOT NULL DEFAULT '[]',
        prompt text,
        target text NOT NULL DEFAULT 'site' CHECK (target IN ('site', 'storybook')),
        story_id text,
        current_revision_id uuid,
        preview jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX screens_node ON screens (project_id, figma_node_id);
      CREATE INDEX screens_group ON screens (project_id, group_id, position);
      CREATE INDEX screens_name_trgm ON screens USING gin (name gin_trgm_ops);
      CREATE INDEX screens_url_trgm ON screens USING gin (url gin_trgm_ops);

      CREATE TABLE screen_revisions (
        id uuid PRIMARY KEY,
        screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
        import_id uuid REFERENCES figma_imports(id) ON DELETE SET NULL,
        content_hash text NOT NULL,
        image_key text,
        thumb_key text,
        spec_key text NOT NULL,
        texts int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX screen_revisions_screen ON screen_revisions (screen_id, created_at DESC);
      ALTER TABLE screens ADD CONSTRAINT screens_current_revision FOREIGN KEY (current_revision_id) REFERENCES screen_revisions(id) ON DELETE SET NULL;

      CREATE TABLE runs (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        target text NOT NULL DEFAULT 'site' CHECK (target IN ('site', 'storybook')),
        total int NOT NULL DEFAULT 0,
        done int NOT NULL DEFAULT 0,
        passed int NOT NULL DEFAULT 0,
        failed int NOT NULL DEFAULT 0,
        blocked int NOT NULL DEFAULT 0,
        errors int NOT NULL DEFAULT 0,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz
      );
      CREATE INDEX runs_project ON runs (project_id, created_at DESC);

      CREATE TABLE results (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
        revision_id uuid REFERENCES screen_revisions(id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'error', 'skipped')),
        url text,
        final_url text,
        coverage real,
        design_score real,
        counts jsonb,
        error text,
        unmocked jsonb NOT NULL DEFAULT '[]',
        viewport_w int,
        viewport_h int,
        screenshot_key text,
        report_key text,
        dom_key text,
        duration_ms int,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX results_run ON results (run_id);
      CREATE INDEX results_screen ON results (screen_id, created_at DESC);

      CREATE TABLE mock_routes (
        id uuid PRIMARY KEY,
        screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
        method text NOT NULL,
        host text NOT NULL,
        path text NOT NULL,
        query jsonb NOT NULL DEFAULT '{}',
        operation_name text,
        variables jsonb,
        status int NOT NULL DEFAULT 200,
        content_type text NOT NULL DEFAULT 'application/json',
        recorded_body jsonb,
        ops jsonb NOT NULL DEFAULT '[]',
        body jsonb,
        violations jsonb NOT NULL DEFAULT '[]',
        origin text NOT NULL DEFAULT 'recorded' CHECK (origin IN ('recorded', 'ai', 'manual')),
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX mock_routes_screen ON mock_routes (screen_id, method, host, path);

      CREATE TABLE login_sessions (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        credential_hash text NOT NULL,
        ciphertext text NOT NULL,
        iv text NOT NULL,
        tag text NOT NULL,
        key_version int NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE repositories (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        url text NOT NULL,
        branch text NOT NULL,
        status text NOT NULL DEFAULT 'none' CHECK (status IN ('none', 'syncing', 'ready', 'failed')),
        head_sha text,
        last_synced_at timestamptz,
        error text,
        job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE ai_calls (
        id uuid PRIMARY KEY,
        project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
        purpose text NOT NULL,
        model text NOT NULL,
        input_tokens int NOT NULL DEFAULT 0,
        output_tokens int NOT NULL DEFAULT 0,
        cost_usd real,
        ok boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ai_calls_project ON ai_calls (project_id, created_at DESC);
    `);
  }

  async down(q: QueryRunner) {
    await q.query(`
      DROP TABLE ai_calls; DROP TABLE repositories; DROP TABLE login_sessions; DROP TABLE mock_routes; DROP TABLE results;
      DROP TABLE runs; ALTER TABLE screens DROP CONSTRAINT screens_current_revision; DROP TABLE screen_revisions;
      DROP TABLE screens; DROP TABLE screen_groups; DROP TABLE figma_imports; ALTER TABLE projects DROP COLUMN storybook_url;
    `);
  }
}
