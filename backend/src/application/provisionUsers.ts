import { roleForStaff, usernameFor } from "../domain/auth.js";
import type { Clock, PasswordHasher, StaffRoster, StoreListing, UserRepository } from "../ports/index.js";

export const MIN_PASSWORD_LENGTH = 12;

export interface ProvisionResult {
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
}

/**
 * Create or refresh one login per store-tool staff member who is a salesperson or store manager, at a store that bills.
 * Identity, role and store assignment all come from the roster, so there is nothing to type in by hand; the only
 * secret is the password, which the operator supplies at run time (never committed). Safe to run again: an account whose
 * password already matches is left alone, and staff no longer on the roster are disabled.
 * Not exposed over HTTP: there is no sign-up endpoint of any kind.
 */
export async function provisionUsers(d: {
  roster: StaffRoster;
  stores: StoreListing;
  users: UserRepository;
  hasher: PasswordHasher;
  clock: Clock;
  password: string;
}): Promise<ProvisionResult> {
  if (d.password.length < MIN_PASSWORD_LENGTH) throw new Error(`The demo password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const billing = new Set((await d.stores.listStores()).map((s) => s.code));
  const at = d.clock.now().toISOString();
  const result: ProvisionResult = { created: 0, updated: 0, unchanged: 0, deactivated: 0 };
  const keep: string[] = [];

  for (const staff of await d.roster.listAll()) {
    const role = roleForStaff(staff.role);
    if (!role || !billing.has(staff.storeCode)) continue;
    const userId = `usr_${staff.staffId}`;
    const username = usernameFor(staff.staffId);
    keep.push(userId);
    const existing = d.users.findByUsername(username);
    const same = existing && existing.active && existing.role === role && existing.name === staff.name && existing.storeCodes.join() === staff.storeCode && existing.userId === userId;
    if (same && (await d.hasher.verify(d.password, existing.passwordHash))) {
      result.unchanged++;
      continue;
    }
    d.users.upsert({ userId, username, passwordHash: await d.hasher.hash(d.password), staffId: staff.staffId, name: staff.name, role, storeCodes: [staff.storeCode], active: true }, at);
    if (existing) result.updated++;
    else result.created++;
  }
  result.deactivated = d.users.deactivateExcept(keep, at);
  return result;
}
