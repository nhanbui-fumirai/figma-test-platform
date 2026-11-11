import { Column, Entity, Index, JoinColumn, ManyToOne, UpdateDateColumn } from "typeorm";
import { BaseEntity } from "./base";
import { Project } from "./project.entity";

export type ImportSource = "fig" | "rest";

/** One import of the Figma design of a project (.fig upload or link). Its job parses, renders and updates the screens. */
@Entity("figma_imports")
@Index(["projectId", "createdAt"])
export class FigmaImport extends BaseEntity {
  @ManyToOne(() => Project, { onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column("uuid", { name: "project_id" })
  projectId: string;

  @Column("text")
  source: ImportSource;

  @Column("text", { name: "file_name" })
  fileName: string;

  /** REST: the file key of the link; .fig: null */
  @Column("text", { name: "file_key", nullable: true })
  fileKey: string | null;

  /** REST: the node of the link (a page or a frame), imports only it */
  @Column("text", { name: "node_id", nullable: true })
  nodeId: string | null;

  /** .fig: the uploaded file in the blob store */
  @Column("text", { name: "blob_key", nullable: true })
  blobKey: string | null;

  @Column("uuid", { name: "job_id", nullable: true })
  jobId: string | null;

  @Column("jsonb", { nullable: true })
  stats: Record<string, number> | null;

  @Column("uuid", { name: "created_by", nullable: true })
  createdBy: string | null;
}

export type GroupKind = "page" | "section";

/**
 * A page or a section of the design (sections nest). Hiding one hides its screens, also the ones a later import
 * adds to it: the flag is on the group, not copied to the screens.
 */
@Entity("screen_groups")
@Index(["projectId", "figmaNodeId"], { unique: true })
export class ScreenGroup extends BaseEntity {
  @Column("uuid", { name: "project_id" })
  projectId: string;

  @Column("uuid", { name: "parent_id", nullable: true })
  parentId: string | null;

  @Column("text", { name: "figma_node_id" })
  figmaNodeId: string;

  @Column("text")
  kind: GroupKind;

  @Column("text")
  name: string;

  @Column("int", { default: 0 })
  position: number;

  @Column("boolean", { default: false })
  hidden: boolean;

  /** not in the design any more (kept: its screens have reports) */
  @Column("boolean", { default: false })
  missing: boolean;
}

export type ScreenTargetKind = "site" | "storybook";

/**
 * A frame of the design and how to test it: the URL of its page and the state to bring the page to (cookies, test
 * login, steps, mocks). Its design is the current revision (image + spec); old results keep the revision they used.
 */
@Entity("screens")
@Index(["projectId", "figmaNodeId"], { unique: true })
@Index(["projectId", "groupId", "position"])
export class Screen extends BaseEntity {
  @ManyToOne(() => Project, { onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column("uuid", { name: "project_id" })
  projectId: string;

  @Column("uuid", { name: "group_id", nullable: true })
  groupId: string | null;

  @Column("text", { name: "figma_node_id" })
  figmaNodeId: string;

  @Column("text")
  name: string;

  @Column("int", { default: 0 })
  position: number;

  @Column("real")
  width: number;

  @Column("real")
  height: number;

  @Column("real", { name: "design_height" })
  designHeight: number;

  @Column("int", { name: "viewport_w" })
  viewportW: number;

  @Column("int", { name: "viewport_h" })
  viewportH: number;

  @Column("boolean", { default: false })
  scrolls: boolean;

  @Column("boolean", { default: false })
  draft: boolean;

  @Column("text", { name: "duplicate_of", nullable: true })
  duplicateOf: string | null;

  @Column("boolean", { default: false })
  hidden: boolean;

  @Column("boolean", { default: false })
  missing: boolean;

  @Column("text", { nullable: true })
  url: string | null;

  @Column("jsonb", { default: [] })
  cookies: unknown[];

  @Column("boolean", { name: "requires_login", default: false })
  requiresLogin: boolean;

  @Column("jsonb", { default: [] })
  steps: unknown[];

  @Column("text", { nullable: true })
  prompt: string | null;

  @Column("text", { default: "site" })
  target: ScreenTargetKind;

  @Column("text", { name: "story_id", nullable: true })
  storyId: string | null;

  @Column("uuid", { name: "current_revision_id", nullable: true })
  currentRevisionId: string | null;

  /** last preview (open without compare): { jobId, status, finalUrl, reason, screenshotKey, unmocked, at } */
  @Column("jsonb", { nullable: true })
  preview: Record<string, unknown> | null;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}

/** The design of a screen at one import: same content hash = same revision, nothing rendered again. */
@Entity("screen_revisions")
@Index(["screenId", "createdAt"])
export class ScreenRevision extends BaseEntity {
  @ManyToOne(() => Screen, { onDelete: "CASCADE" })
  @JoinColumn({ name: "screen_id" })
  screen: Screen;

  @Column("uuid", { name: "screen_id" })
  screenId: string;

  @Column("uuid", { name: "import_id", nullable: true })
  importId: string | null;

  @Column("text", { name: "content_hash" })
  contentHash: string;

  /** PNG of the design (frame width × design height) */
  @Column("text", { name: "image_key", nullable: true })
  imageKey: string | null;

  @Column("text", { name: "thumb_key", nullable: true })
  thumbKey: string | null;

  /** DesignSpec (gzip JSON) */
  @Column("text", { name: "spec_key" })
  specKey: string;

  /** texts of the design, for search and the AI prompts */
  @Column("int", { default: 0 })
  texts: number;
}
