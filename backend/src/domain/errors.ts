// Errors the till shows to sales staff. `code` is stable for clients; `message` says what to do next.

export type DomainErrorCode =
  | "INVALID_PHONE"
  | "CUSTOMER_NOT_FOUND"
  | "CUSTOMER_AMBIGUOUS"
  | "CUSTOMER_EXISTS"
  | "CUSTOMER_INVALID"
  | "STORE_NOT_FOUND"
  | "STAFF_NOT_AT_STORE"
  | "CART_NOT_FOUND"
  | "CART_CLOSED"
  | "PAIR_EMPTY"
  | "PAIR_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "WRONG_ITEM_TYPE"
  | "ITEM_NOT_SELLABLE"
  | "OUT_OF_STOCK"
  | "FRAME_NOT_RX_ABLE"
  | "RX_REQUIRED"
  | "RX_NOT_FOUND"
  | "RX_NOT_IN_FORCE"
  | "RX_UNAVAILABLE"
  | "LENS_RX_MISMATCH"
  | "MANUAL_DISCOUNT_INVALID"
  | "TAX_RATE_MISSING"
  | "BILL_NOT_FOUND"
  | "BILL_NOT_CANCELLABLE"
  | "REFUND_NOT_ALLOWED"
  | "REFUND_MISMATCH"
  | "CREDIT_NOTE_NOT_FOUND";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
