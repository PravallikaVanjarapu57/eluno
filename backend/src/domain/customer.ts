// A billing customer as the till sees it. The id is opaque: the till never does arithmetic on it or
// assumes it is a Shopify id, so a different system of record can supply its own.

export type CustomerId = string;

export interface Customer {
  id: CustomerId;
  firstName: string;
  lastName: string;
  phone: string;
  /** Absent for customers created before email was captured, and for ones Shopify has none for. */
  email?: string | null;
  tags: string[];
  lifetimeSpendPaise: number;
  ordersCount: number;
}

/** What the billing screen flags, same as the queue tool: priority customers and campaign walk-ins. */
export interface CustomerFlags {
  priority: boolean;
  family: boolean;
  campaigns: string[];
}

export function flagsOf(customer: Customer): CustomerFlags {
  return {
    priority: customer.tags.includes("priority"),
    family: customer.tags.includes("family"),
    campaigns: customer.tags.filter((t) => t.startsWith("campaign:")).map((t) => t.slice("campaign:".length)),
  };
}

export function hasTag(customer: Customer, tag: string): boolean {
  return customer.tags.includes(tag);
}

export interface CustomerDetails {
  firstName: string;
  lastName: string;
  email: string | null;
}

export type FieldErrors = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The rules for the fields staff may type, shared by create and edit. Returns the cleaned values or a message per field. */
export function checkCustomerDetails(input: { firstName?: string; lastName?: string; email?: string | null }): { ok: true; value: CustomerDetails } | { ok: false; fields: FieldErrors } {
  const fields: FieldErrors = {};
  const firstName = (input.firstName ?? "").trim();
  const lastName = (input.lastName ?? "").trim();
  const email = (input.email ?? "").trim();
  if (!firstName) fields.firstName = "First name is required.";
  else if (firstName.length > 60) fields.firstName = "First name is too long (60 characters at most).";
  if (lastName.length > 60) fields.lastName = "Last name is too long (60 characters at most).";
  if (email && (email.length > 120 || !EMAIL.test(email))) fields.email = "That does not look like an email address.";
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, value: { firstName, lastName, email: email || null } };
}

export const fullName = (c: Pick<Customer, "firstName" | "lastName">): string => `${c.firstName} ${c.lastName}`.trim();
