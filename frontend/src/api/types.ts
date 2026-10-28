// Shapes of the till API responses (backend/src/api/routes/*). Money is integer paise throughout.

export type Paise = number;
export type PaymentMethod = "upi" | "card" | "cash";
export type Channel = "walk_in" | "whatsapp_booked" | "online_pickup";
export const PAYMENT_METHODS: PaymentMethod[] = ["upi", "card", "cash"];
export const CHANNELS: { value: Channel; label: string }[] = [
  { value: "walk_in", label: "Walk-in" },
  { value: "whatsapp_booked", label: "WhatsApp booked" },
  { value: "online_pickup", label: "Online pickup" },
];

export type Role = "salesperson" | "store_manager";
export type Permission = "customer:create" | "billing:use" | "refund:create" | "discount:manager" | "report:view" | "report:download";
/** The signed-in user as the server describes them. Permissions only drive what the UI shows; the server enforces them. */
export interface User { username: string; staffId: string; name: string; role: Role; storeCodes: string[]; permissions: Permission[] }
export interface Session { user: User; csrfToken: string }

export interface Store { code: string; name: string; invoicePrefix: string }
export interface Staff { staffId: string; name: string; role: "sales" | "optometrist" | "store_manager"; canOverrideDiscount: boolean }
export interface ReasonCode { code: string; label: string }
export interface ReasonCodes { discount: ReasonCode[]; refund: ReasonCode[] }

export interface Frame { variantId: string; sku: string; title: string; category: "optical" | "sunglasses"; rxAble: boolean; pricePaise: Paise; hsn: string; available: number }

export interface Eye { sph: number; cyl: number; axis: number | null; add: number | null }
export interface Prescription {
  rxId: string; customerId: string; testedOn: string; validUntil: string; source: "in_store" | "external"; optometristId: string | null;
  od: Eye; os: Eye; pd: { binocular: number | null; monoR: number | null; monoL: number | null }; notes: string | null;
}
export interface SkippedRx { rxId: string; reason: string }
export type PrescriptionLookup =
  | { status: "valid"; rx: Prescription; warnings: string[]; skipped: SkippedRx[] }
  | { status: "expired"; latest: Prescription; reason: string; skipped: SkippedRx[] }
  | { status: "none_on_file"; reason: string; skipped: SkippedRx[] }
  | { status: "unavailable"; reason: string };

export interface Customer { id: string; firstName: string; lastName: string; phone: string; tags: string[]; lifetimeSpendPaise: Paise; ordersCount: number }
export interface CustomerLookup { customer: Customer; flags: { priority: boolean; family: boolean; campaigns: string[] }; prescription: PrescriptionLookup }

export interface LensOption {
  variantId: string; sku: string; description: string; type: string; index: number; coating: string; pricePaise: Paise; labTatDays: number; valid: boolean; reasons: string[];
}
export interface LensMatrix { rxId: string; options: LensOption[] }

export interface CartPair {
  pairRef: string;
  frame: { variantId: string; sku: string; title: string; hsn: string; pricePaise: Paise } | null;
  lens: { variantId: string; sku: string; description: string; hsn: string; pricePaise: Paise; labTatDays: number; rxId: string } | null;
}
export interface Cart {
  id: string; status: string; storeCode: string; staffId: string; channel: Channel;
  customer: { id: string; name: string; phone: string; tags: string[] };
  pairs: CartPair[]; manualDiscount: { approverId: string; reasonCode: string; bps: number } | null; mrpTotalPaise: Paise;
}

export interface QuoteLine {
  lineId: string; pairRef: string; kind: "frame" | "lens"; sku: string; hsn: string;
  grossPaise: Paise; discountPaise: Paise; netPaise: Paise; rateBps: number; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise;
}
export interface Totals { grossPaise: Paise; discountPaise: Paise; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; taxPaise: Paise; payablePaise: Paise }
export interface Quote {
  invoiceDate: string; lines: QuoteLine[]; totals: Totals;
  appliedOffers: { offerId: string; name: string; amountPaise: Paise }[];
  offerEvaluations: { offerId: string; name: string; applied: boolean; amountPaise: Paise; why: string }[];
}

export type BillStatus = "NUMBERED" | "CHARGED" | "CHARGED_NOT_POSTED" | "POSTED" | "CANCELLED";
export interface BillLine {
  lineId: string; sku: string; title: string; hsn: string; grossPaise: Paise; discountPaise: Paise; taxablePaise: Paise; rateBps: number;
  cgstPaise: Paise; sgstPaise: Paise; totalPaise: Paise; rxId?: string; lensConfig?: string;
}
export interface Bill {
  invoiceNo: string; status: BillStatus; nextStep: string; store: string; customer: { id: string; name: string; phone: string }; channel: Channel; invoiceDate: string;
  lines: BillLine[]; appliedOffers: { offerId: string; name: string; amountPaise: Paise }[];
  manualDiscount: { approverId: string; reasonCode: string; bps: number } | null; totals: Totals;
  payment: { method: PaymentMethod; amountPaise: Paise; chargeId: string | null; at: string } | null;
  shopify: { orderId: string; orderName: string } | null; lastError: string | null; cancelReason: string | null;
}
export interface BillSummary { invoiceNo: string; status: BillStatus; customerName: string; payablePaise: Paise; paymentMethod: PaymentMethod; createdAt: string }

export type CreditNoteStatus = "NUMBERED" | "REFUNDED" | "REFUNDED_NOT_POSTED" | "POSTED" | "CANCELLED";
export interface CreditNote {
  creditNoteNo: string; invoiceNo: string; status: CreditNoteStatus; nextStep: string; store: string; customer: { id: string; name: string; phone: string };
  reasonCode: string; staffId: string; refundMethod: string;
  lines: { lineId: string; sku: string; hsn: string; rateBps: number; amountPaise: Paise; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; restock: string }[];
  totals: { amountPaise: Paise; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; taxPaise?: Paise };
  shopify: { refundId: string } | null; lastError: string | null; cancelReason: string | null;
}

export interface Mismatch { kind: string; severity: "error" | "info"; ref: string; detail: string }
export interface DayEndReport {
  storeCode: string; date: string; source: string;
  sales: { bills: number; grossPaise: Paise; discountPaise: Paise; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; taxPaise: Paise; netSalesPaise: Paise; zeroValueBills: number; cancelledBills: number; averageBillPaise: Paise };
  refunds: { count: number; amountPaise: Paise; taxablePaise: Paise; taxPaise: Paise };
  netAfterRefundsPaise: Paise;
  byPaymentMethod: Record<string, { salesPaise: Paise; refundsPaise: Paise; netPaise: Paise; bills: number }>;
  byChannel: Record<string, { bills: number; netSalesPaise: Paise }>;
  discountsByOffer: Record<string, Paise>;
  invoices: { first: string | null; last: string | null; cancelled: string[] };
  reconciliation: { status: "matched" | "mismatch"; mismatches: Mismatch[] };
}
