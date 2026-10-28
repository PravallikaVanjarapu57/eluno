import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../domain/auth.js";
import type { AuditLog, Clock, PasswordHasher, SessionRepository, UserRecord, UserRepository } from "../ports/index.js";

export interface AuthPolicy {
  /** Signed out after this long without a request. */
  idleMs: number;
  /** Signed out this long after login, however active. */
  maxMs: number;
  /** Consecutive wrong passwords for one username before it is locked. */
  maxFailures: number;
  lockMs: number;
}

export const DEFAULT_POLICY: AuthPolicy = { idleMs: 2 * 3600_000, maxMs: 12 * 3600_000, maxFailures: 5, lockMs: 15 * 60_000 };

export interface LoginResult {
  principal: Principal;
  /** The cookie value. Shown once; only its hash is stored. */
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}

export interface SessionInfo {
  principal: Principal;
  csrfToken: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");

export const principalOf = (u: UserRecord): Principal => ({ userId: u.userId, username: u.username, staffId: u.staffId, name: u.name, role: u.role, storeCodes: u.storeCodes });

/** Sign-in, server-side sessions and brute-force protection. Identity and role always come from the stored user, never from a request. */
export class AuthService {
  private readonly failures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
  private dummyHash: Promise<string> | null = null;
  private readonly policy: AuthPolicy;

  constructor(
    private readonly d: { users: UserRepository; sessions: SessionRepository; hasher: PasswordHasher; clock: Clock; audit: AuditLog; policy?: Partial<AuthPolicy> },
  ) {
    this.policy = { ...DEFAULT_POLICY, ...d.policy };
  }

  async login(rawUsername: string, password: string): Promise<LoginResult> {
    const username = rawUsername.trim().toLowerCase();
    const nowMs = this.d.clock.now().getTime();
    const state = this.failures.get(username);
    if (state && state.lockedUntil > nowMs) {
      const retryAfterSeconds = Math.ceil((state.lockedUntil - nowMs) / 1000);
      throw new DomainError("TOO_MANY_LOGINS", `Too many wrong passwords. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`, { retryAfterSeconds });
    }

    const user = this.d.users.findByUsername(username);
    // Verify against a throwaway hash for unknown users too, so response time does not reveal which usernames exist.
    const ok = await this.d.hasher.verify(password, user?.passwordHash ?? (await this.dummy()));
    if (!user || !user.active || !ok) {
      this.recordFailure(username, nowMs);
      this.audit(username, "auth.login_failed", username);
      throw new DomainError("INVALID_CREDENTIALS", "Wrong username or password.");
    }
    this.failures.delete(username);

    const now = this.d.clock.now();
    this.d.sessions.purge(now.toISOString(), new Date(nowMs - this.policy.idleMs).toISOString());
    const sessionToken = token(32);
    const csrfToken = token(24);
    const expiresAt = new Date(nowMs + this.policy.maxMs).toISOString();
    this.d.sessions.create({ sessionHash: sha256(sessionToken), userId: user.userId, csrfToken, createdAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt });
    this.audit(user.staffId, "auth.login", user.username, { role: user.role });
    return { principal: principalOf(user), sessionToken, csrfToken, expiresAt };
  }

  /** The signed-in user for a cookie value, or null when it is unknown, expired or idle, or the account is disabled. */
  authenticate(sessionToken: string | undefined): SessionInfo | null {
    if (!sessionToken) return null;
    const hash = sha256(sessionToken);
    const s = this.d.sessions.get(hash);
    if (!s) return null;
    const now = this.d.clock.now();
    const nowMs = now.getTime();
    if (Date.parse(s.expiresAt) <= nowMs || nowMs - Date.parse(s.lastSeenAt) >= this.policy.idleMs) {
      this.d.sessions.delete(hash);
      return null;
    }
    const user = this.d.users.findById(s.userId);
    if (!user || !user.active) {
      this.d.sessions.delete(hash);
      return null;
    }
    if (nowMs - Date.parse(s.lastSeenAt) > 60_000) this.d.sessions.touch(hash, now.toISOString()); // sliding idle window, without a write per request
    return { principal: principalOf(user), csrfToken: s.csrfToken };
  }

  logout(sessionToken: string | undefined): void {
    if (!sessionToken) return;
    const info = this.authenticate(sessionToken);
    this.d.sessions.delete(sha256(sessionToken));
    if (info) this.audit(info.principal.staffId, "auth.logout", info.principal.username);
  }

  private dummy(): Promise<string> {
    return (this.dummyHash ??= this.d.hasher.hash(token(12)));
  }

  /** Failures count within a window of `lockMs`; reaching the limit locks the username for `lockMs`. */
  private recordFailure(username: string, nowMs: number): void {
    const prev = this.failures.get(username);
    const fresh = !prev || nowMs - prev.firstAt >= this.policy.lockMs;
    const count = fresh ? 1 : prev.count + 1;
    this.failures.set(username, { count, firstAt: fresh ? nowMs : prev.firstAt, lockedUntil: count >= this.policy.maxFailures ? nowMs + this.policy.lockMs : 0 });
  }

  private audit(staffId: string, action: string, ref: string, payload?: Record<string, unknown>): void {
    this.d.audit.record({ at: this.d.clock.now().toISOString(), staffId, action, ref: `user:${ref}`, ...(payload ? { payload } : {}) });
  }
}
