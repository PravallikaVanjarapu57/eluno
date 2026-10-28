import type { Db } from "./db.js";
import type { SessionRecord, SessionRepository, UserRecord, UserRepository } from "../../ports/index.js";
import type { Role } from "../../domain/auth.js";

interface UserRow {
  user_id: string;
  username: string;
  password_hash: string;
  staff_id: string;
  name: string;
  role: Role;
  store_codes: string;
  active: number;
}

const toUser = (r: UserRow): UserRecord => ({
  userId: r.user_id,
  username: r.username,
  passwordHash: r.password_hash,
  staffId: r.staff_id,
  name: r.name,
  role: r.role,
  storeCodes: JSON.parse(r.store_codes) as string[],
  active: r.active === 1,
});

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  findByUsername(username: string): UserRecord | null {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  findById(userId: string): UserRecord | null {
    const r = this.db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  upsert(u: UserRecord, at: string): void {
    this.db
      .prepare(
        `INSERT INTO users (user_id, username, password_hash, staff_id, name, role, store_codes, active, created_at, updated_at)
         VALUES (@userId, @username, @passwordHash, @staffId, @name, @role, @storeCodes, @active, @at, @at)
         ON CONFLICT(user_id) DO UPDATE SET username = @username, password_hash = @passwordHash, staff_id = @staffId, name = @name,
           role = @role, store_codes = @storeCodes, active = @active, updated_at = @at`,
      )
      .run({ ...u, storeCodes: JSON.stringify(u.storeCodes), active: u.active ? 1 : 0, at });
  }

  deactivateExcept(userIds: readonly string[], at: string): number {
    const keep = new Set(userIds);
    const stale = (this.db.prepare("SELECT user_id FROM users WHERE active = 1").all() as { user_id: string }[]).filter((r) => !keep.has(r.user_id));
    for (const r of stale) {
      this.db.prepare("UPDATE users SET active = 0, updated_at = ? WHERE user_id = ?").run(at, r.user_id);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(r.user_id);
    }
    return stale.length;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1").get() as { n: number }).n;
  }
}

interface SessionRow {
  session_hash: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  create(s: SessionRecord): void {
    this.db
      .prepare("INSERT INTO sessions (session_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.sessionHash, s.userId, s.csrfToken, s.createdAt, s.lastSeenAt, s.expiresAt);
  }

  get(sessionHash: string): SessionRecord | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE session_hash = ?").get(sessionHash) as SessionRow | undefined;
    return r ? { sessionHash: r.session_hash, userId: r.user_id, csrfToken: r.csrf_token, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at } : null;
  }

  touch(sessionHash: string, at: string): void {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_hash = ?").run(at, sessionHash);
  }

  delete(sessionHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_hash = ?").run(sessionHash);
  }

  deleteForUser(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  purge(now: string, idleBefore: string): number {
    return this.db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at < ?").run(now, idleBefore).changes;
  }
}
