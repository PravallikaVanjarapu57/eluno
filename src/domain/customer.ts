// A billing customer as the till sees it. The id is opaque: the till never does arithmetic on it or
// assumes it is a Shopify id, so a different system of record can supply its own.

export type CustomerId = string;

export interface Customer {
  id: CustomerId;
  firstName: string;
  lastName: string;
  phone: string;
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
