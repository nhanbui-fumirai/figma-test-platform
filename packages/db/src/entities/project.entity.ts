import { Column, DeleteDateColumn, Entity, Index, JoinColumn, ManyToOne, UpdateDateColumn } from "typeorm";
import { BaseEntity } from "./base";

/** A website compared with its Figma design. */
@Entity("projects")
export class Project extends BaseEntity {
  @Column("text")
  name: string;

  @Index({ unique: true, where: "deleted_at IS NULL" })
  @Column("text")
  slug: string;

  /** every screen URL is a path relative to it */
  @Column("text", { name: "base_url" })
  baseUrl: string;

  @Column("jsonb", { default: {} })
  settings: Record<string, unknown>;

  /** Storybook of the frontend, for screens whose target is a story */
  @Column("text", { name: "storybook_url", nullable: true })
  storybookUrl: string | null;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;

  @DeleteDateColumn({ type: "timestamptz", name: "deleted_at" })
  deletedAt: Date | null;
}

export type CredentialKind = "figma_token" | "github_token" | "test_login" | "ai_key";

/**
 * A secret (token, password), sealed with APP_SECRET (AES-256-GCM, @figtest/core crypto). projectId null = a platform-wide
 * secret (an AI key). Never returned to the web: only `hint` (its last characters) and `meta` (non-secret fields).
 */
@Entity("credentials")
@Index(["projectId", "kind"], { unique: true })
export class Credential extends BaseEntity {
  @ManyToOne(() => Project, { onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "project_id" })
  project: Project | null;

  @Column("uuid", { name: "project_id", nullable: true })
  projectId: string | null;

  @Column("text")
  kind: CredentialKind;

  @Column("text")
  ciphertext: string;

  @Column("text")
  iv: string;

  @Column("text")
  tag: string;

  @Column("int", { name: "key_version" })
  keyVersion: number;

  @Column("text", { default: "" })
  hint: string;

  @Column("jsonb", { default: {} })
  meta: Record<string, unknown>;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}
