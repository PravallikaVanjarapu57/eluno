import type { ErrorRequestHandler } from "express";
import { ZodError, z } from "zod";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { AmbiguousWriteError, HttpError, RetriesExhaustedError, UpstreamShapeError } from "../adapters/http/client.js";

const STATUS: Record<DomainErrorCode, number> = {
  INVALID_PHONE: 400,
  CUSTOMER_NOT_FOUND: 404,
  CUSTOMER_AMBIGUOUS: 409,
  CUSTOMER_EXISTS: 409,
  CUSTOMER_INVALID: 422,
  STORE_NOT_FOUND: 404,
  STAFF_NOT_AT_STORE: 403,
  CART_NOT_FOUND: 404,
  CART_CLOSED: 409,
  PAIR_EMPTY: 400,
  PAIR_NOT_FOUND: 404,
  ITEM_NOT_FOUND: 404,
  WRONG_ITEM_TYPE: 422,
  ITEM_NOT_SELLABLE: 422,
  OUT_OF_STOCK: 409,
  FRAME_NOT_RX_ABLE: 422,
  RX_REQUIRED: 422,
  RX_NOT_FOUND: 404,
  RX_NOT_IN_FORCE: 422,
  RX_UNAVAILABLE: 503,
  LENS_RX_MISMATCH: 422,
  MANUAL_DISCOUNT_INVALID: 422,
  TAX_RATE_MISSING: 422,
  BILL_NOT_FOUND: 404,
  BILL_NOT_CANCELLABLE: 409,
  REFUND_NOT_ALLOWED: 409,
  REFUND_MISMATCH: 409,
  CREDIT_NOTE_NOT_FOUND: 404,
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof DomainError) {
    res.status(STATUS[err.code]).json({ code: err.code, message: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ code: "BAD_REQUEST", message: z.prettifyError(err) });
    return;
  }
  if (err instanceof HttpError || err instanceof RetriesExhaustedError || err instanceof AmbiguousWriteError) {
    console.error(err.message);
    res.status(502).json({ code: "UPSTREAM_UNAVAILABLE", message: "An upstream system (Shopify, store tool or terminal) is not responding. Try again." });
    return;
  }
  if (err instanceof UpstreamShapeError) {
    console.error(err.message);
    res.status(502).json({ code: "UPSTREAM_BAD_RESPONSE", message: `${err.upstream} sent data the till does not understand. Tell the tech team.` });
    return;
  }
  console.error(err);
  res.status(500).json({ code: "INTERNAL", message: "Unexpected error" });
};
