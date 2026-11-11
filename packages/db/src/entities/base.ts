import { BeforeInsert, CreateDateColumn, PrimaryColumn } from "typeorm";
import { v7 as uuidv7 } from "uuid";

/**
 * Every table: a UUIDv7 id (time-ordered, so indexes stay compact and ids sort by creation) set by the app before the
 * insert, and the creation time.
 */
export abstract class BaseEntity {
  @PrimaryColumn("uuid")
  id: string;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt: Date;

  @BeforeInsert()
  protected assignId() {
    this.id ??= uuidv7();
  }
}

export const newId = () => uuidv7();
