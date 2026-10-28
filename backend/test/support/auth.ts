import request from "supertest";
import type { Express } from "express";
import { ScryptHasher } from "../../src/adapters/crypto/scrypt.js";
import { SqliteUserRepository } from "../../src/adapters/sqlite/authRepo.js";
import type { Composed } from "../../src/compose.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import type { Role } from "../../src/domain/auth.js";

/** Not a real credential: a throwaway used only against in-memory databases in tests. */
export const TEST_PASSWORD = "test-only password 0123456789";

/** Environment for tests: cheap password hashing, everything else as in development. */
export function testEnv(overrides: Record<string, string>): Env {
  return loadEnv({ AUTH_SCRYPT_LOG2N: "10", DB_PATH: ":memory:", ...overrides });
}

/** Accounts for every salesperson and store manager on the mock's roster (usernames: lower-case staff ids). */
export const provisionAll = (deps: Composed) => deps.provision(TEST_PASSWORD);

/** An account that does not depend on the roster (for tests whose upstreams are fakes). */
export async function addUser(deps: Composed, u: { staffId: string; role: Role; storeCodes: string[]; name?: string; active?: boolean }): Promise<void> {
  new SqliteUserRepository(deps.db).upsert(
    {
      userId: `usr_${u.staffId}`,
      username: u.staffId.toLowerCase(),
      passwordHash: await new ScryptHasher(10).hash(TEST_PASSWORD),
      staffId: u.staffId,
      name: u.name ?? u.staffId,
      role: u.role,
      storeCodes: u.storeCodes,
      active: u.active ?? true,
    },
    new Date().toISOString(),
  );
}

/** A signed-in browser: keeps the session cookie and sends the CSRF token on writes, like the real UI. */
export interface Session {
  csrf: string;
  user: { staffId: string; role: Role; storeCodes: string[] };
  get(path: string): request.Test;
  post(path: string): request.Test;
  put(path: string): request.Test;
  patch(path: string): request.Test;
  delete(path: string): request.Test;
}

export async function signIn(app: Express, username: string, password = TEST_PASSWORD): Promise<Session> {
  const agent = request.agent(app);
  const res = await agent.post("/auth/login").send({ username, password });
  if (res.status !== 200) throw new Error(`sign-in as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken as string;
  return {
    csrf,
    user: res.body.user,
    get: (p) => agent.get(p),
    post: (p) => agent.post(p).set("X-CSRF-Token", csrf),
    put: (p) => agent.put(p).set("X-CSRF-Token", csrf),
    patch: (p) => agent.patch(p).set("X-CSRF-Token", csrf),
    delete: (p) => agent.delete(p).set("X-CSRF-Token", csrf),
  };
}
