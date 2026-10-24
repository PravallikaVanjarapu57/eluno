import { Router } from "express";
import { z } from "zod";
import type { Checkout } from "../../application/checkout.js";
import { PAYMENT_METHODS, type Bill } from "../../domain/bill.js";

const CheckoutBody = z.object({ paymentMethod: z.enum(PAYMENT_METHODS) });
const CancelBody = z.object({ staffId: z.string().min(1), reason: z.string().min(3) });

const NEXT_STEP: Record<Bill["status"], string> = {
  POSTED: "Done. Print the invoice.",
  CHARGED: "Paid. Posting to Shopify.",
  CHARGED_NOT_POSTED: "Paid; Shopify has not confirmed yet. The customer can leave; the till will keep retrying. Print the invoice.",
  NUMBERED: "Payment not confirmed. Check the terminal, then resume (safe: it will not charge twice) or cancel.",
  CANCELLED: "Cancelled. The invoice number stays in the series as cancelled.",
};

export function billView(b: Bill) {
  return {
    invoiceNo: b.invoiceNo,
    status: b.status,
    nextStep: NEXT_STEP[b.status],
    store: b.store.code,
    customer: b.customer,
    channel: b.channel,
    invoiceDate: b.invoiceDate,
    lines: b.lines.map((l) => ({
      lineId: l.lineId, sku: l.sku, title: l.title, hsn: l.hsn, grossPaise: l.grossPaise, discountPaise: l.discountPaise,
      taxablePaise: l.taxablePaise, rateBps: l.rateBps, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, totalPaise: l.netPaise,
      ...(l.lens ? { rxId: l.lens.rxId, lensConfig: l.lens.configKey } : {}),
    })),
    appliedOffers: b.appliedOffers,
    manualDiscount: b.manualDiscount && { approverId: b.manualDiscount.approverId, reasonCode: b.manualDiscount.reasonCode, bps: b.manualDiscount.bps },
    totals: b.totals,
    payment: b.payment,
    shopify: b.posted && { orderId: b.posted.orderRef, orderName: b.posted.orderName },
    lastError: b.lastError,
    cancelReason: b.cancelReason,
  };
}

const statusCode = (b: Bill) => (b.status === "POSTED" ? 201 : b.status === "CANCELLED" ? 402 : 202);

export function checkoutRoute(checkout: Checkout): Router {
  const r = Router();
  // POST /carts/:id/checkout {paymentMethod}
  r.post("/:id/checkout", async (req, res) => {
    const { paymentMethod } = CheckoutBody.parse(req.body);
    const bill = await checkout.checkout(req.params.id, paymentMethod);
    res.status(statusCode(bill)).json(billView(bill));
  });
  return r;
}

export function billRoutes(checkout: Checkout): Router {
  const r = Router();
  // Invoice numbers contain slashes (ELU/HSR/FY26/00001): clients URL-encode them.
  r.get("/:invoiceNo", (req, res) => {
    res.json(billView(checkout.get(req.params.invoiceNo)));
  });
  r.post("/:invoiceNo/resume", async (req, res) => {
    const bill = await checkout.resume(req.params.invoiceNo);
    res.status(statusCode(bill) === 201 ? 200 : statusCode(bill)).json(billView(bill));
  });
  r.post("/:invoiceNo/cancel", (req, res) => {
    const { staffId, reason } = CancelBody.parse(req.body);
    res.json(billView(checkout.cancel(req.params.invoiceNo, staffId, reason)));
  });
  return r;
}
