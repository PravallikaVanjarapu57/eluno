export interface Store {
  code: string;
  name: string;
  /** Opaque reference to the store in the system of record (Shopify location). */
  locationRef: string;
  invoicePrefix: string;
  stateCode: string;
  active: boolean;
}

export type StaffRole = "sales" | "optometrist" | "store_manager";

export interface Staff {
  staffId: string;
  name: string;
  role: StaffRole;
  storeCode: string;
  badges: string[];
  canOverrideDiscount: boolean;
}

export const CHANNELS = ["walk_in", "whatsapp_booked", "online_pickup"] as const;
export type Channel = (typeof CHANNELS)[number];
