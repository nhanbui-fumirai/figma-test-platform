/**
 * Sign in with email + password (argon2id). A session is a random token in an httpOnly cookie; the database keeps its
 * SHA-256 only, so a stolen database does not give sessions. Sessions slide: used, they are extended up to SESSION_DAYS.
 */
import { Inject, Injectable, type OnApplicationBootstrap, UnauthorizedException } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import type { Me } from "@figtest/contracts";
import { randomToken, sha256, type Env, type Logger } from "@figtest/core";
import { Session, User } from "@figtest/db";
import type { DataSource } from "typeorm";
import { DATA_SOURCE, ENV, LOGGER } from "../../infra/tokens";

export const SESSION_COOKIE = "figtest_session";
export const SESSION_DAYS = 14;
const DAY = 24 * 3600_000;

const toMe = (u: User): Me => ({ id: u.id, email: u.email, role: u.role });

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  private get users() {
    return this.ds.getRepository(User);
  }

  private get sessions() {
    return this.ds.getRepository(Session);
  }

  /** argon2id hash of a random value: an unknown email is checked against it, same time as a real check */
  private dummyHash = "";

  /** First start: the admin of ADMIN_EMAIL / ADMIN_PASSWORD when there is no user yet. */
  async onApplicationBootstrap() {
    this.dummyHash = await hash(randomToken());
    if ((await this.users.count()) > 0) return;
    if (!this.env.ADMIN_EMAIL || !this.env.ADMIN_PASSWORD) {
      this.log.warn("no user yet: set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the first admin");
      return;
    }
    await this.users.save(this.users.create({ email: this.env.ADMIN_EMAIL.toLowerCase(), passwordHash: await hash(this.env.ADMIN_PASSWORD), role: "admin" }));
    this.log.info(`admin ${this.env.ADMIN_EMAIL} created`);
  }

  /** The user and a new session token (for the cookie), or 401. */
  async login(email: string, password: string): Promise<{ me: Me; token: string }> {
    const user = await this.users.findOneBy({ email: email.toLowerCase() });
    // same answer and similar time whether the email exists or not
    const ok = await verify(user?.passwordHash ?? this.dummyHash, password).catch(() => false) && !!user;
    if (!user || !ok) throw new UnauthorizedException("wrong email or password");
    const token = randomToken();
    const now = new Date();
    await this.sessions.save(this.sessions.create({ userId: user.id, tokenHash: sha256(token), lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY) }));
    return { me: toMe(user), token };
  }

  async logout(token: string | undefined) {
    if (token) await this.sessions.delete({ tokenHash: sha256(token) });
  }

  /** The user of a session token, or null when it is unknown or expired. */
  async userOf(token: string | undefined): Promise<Me | null> {
    if (!token) return null;
    const session = await this.sessions.findOne({ where: { tokenHash: sha256(token) }, relations: { user: true } });
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() < now) {
      await this.sessions.delete({ id: session.id });
      return null;
    }
    // slide the expiry at most once an hour
    if (now - session.lastSeenAt.getTime() > 3600_000) {
      await this.sessions.update({ id: session.id }, { lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_DAYS * DAY) });
    }
    return toMe(session.user);
  }
}

