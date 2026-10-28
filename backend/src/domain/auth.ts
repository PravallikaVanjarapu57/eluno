import type { StaffRole } from "./store.js";

// The two roles the client has approved. Optometrists in the store tool have no login: a third role has not been asked for.
export type Role = "salesperson" | "store_manager";

/** Who is making a request, as resolved on the server from the session. Never built from request input. */
export interface Principal {
  userId: string;
  username: string;
  /** The store-tool staff id recorded on bills, refunds and the audit log. */
  staffId: string;
  name: string;
  role: Role;
  storeCodes: readonly string[];
}

export type Permission =
  | "customer:create"
  | "billing:use" // carts, offers, checkout, resume/cancel of an unpaid bill, recent bills
  | "refund:create"
  | "discount:manager" // apply a manager discount (the approver is the signed-in manager)
  | "report:view" // day-end on screen
  | "report:download"; // day-end CSV

/**
 * The permission matrix. Lens validation rules are deliberately in nobody's set: who may administer them
 * is an open question for the client, so no role can, and the API rejects every attempt.
 * Reports are manager-only until the client confirms whether salespeople may see them on screen.
 * Store managers can do everything a salesperson can (they bill too).
 */
const SALES: readonly Permission[] = ["customer:create", "billing:use", "refund:create"];
export const PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  salesperson: new Set(SALES),
  store_manager: new Set<Permission>([...SALES, "discount:manager", "report:view", "report:download"]),
};

export const can = (p: Principal, permission: Permission): boolean => PERMISSIONS[p.role].has(permission);
export const permissionsOf = (role: Role): Permission[] => [...PERMISSIONS[role]];
export const canAccessStore = (p: Principal, storeCode: string): boolean => p.storeCodes.includes(storeCode);

/** Store-tool roster role -> login role. Optometrists get no account. */
export function roleForStaff(staffRole: StaffRole): Role | null {
  return staffRole === "sales" ? "salesperson" : staffRole === "store_manager" ? "store_manager" : null;
}

export const usernameFor = (staffId: string): string => staffId.trim().toLowerCase();
