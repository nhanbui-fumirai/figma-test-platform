import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "./base";

export type Role = "admin" | "member";

/** A person who signs in to the platform. The email is kept lower case. */
@Entity("users")
export class User extends BaseEntity {
  @Index({ unique: true })
  @Column("text")
  email: string;

  @Column("text", { name: "password_hash" })
  passwordHash: string;

  @Column("text", { default: "member" })
  role: Role;
}

/** A signed-in browser: the cookie holds a random token, the table only its SHA-256. */
@Entity("sessions")
export class Session extends BaseEntity {
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column("uuid", { name: "user_id" })
  userId: string;

  @Index({ unique: true })
  @Column("text", { name: "token_hash" })
  tokenHash: string;

  @Column("timestamptz", { name: "expires_at" })
  expiresAt: Date;

  @Column("timestamptz", { name: "last_seen_at" })
  lastSeenAt: Date;
}
