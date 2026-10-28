import { Router } from "express";
import { z } from "zod";
import type { Refunds } from "../../application/refunds.js";
import type { CreditNote } from "../../domain/refund.js";

const RefundBody = z.object({ staffId: z.string().min(1), reasonCode: z.string().min(1), note: z.string().optional() });

const NEXT_STEP: Record<CreditNote["status"], string> = {
  POSTED: "Done. Print the credit note.",
  REFUNDED: "Money returned. Recording the refund in Shopify.",
  REFUNDED_NOT_POSTED: "Money returned; Shopify has not confirmed yet. The till will keep retrying. Print the credit note.",
  NUMBERED: "Refund not confirmed yet. Resume to continue (safe: it checks before paying out again).",
  CANCELLED: "Not refunded. The credit note number stays in the series as cancelled.",
};

export function creditNoteView(cn: CreditNote) {
  return {
    creditNoteNo: cn.creditNoteNo,
    invoiceNo: cn.invoiceNo,
    status: cn.status,
    nextStep: NEXT_STEP[cn.status],
    store: cn.store.code,
    customer: cn.customer,
    reasonCode: cn.reasonCode,
    staffId: cn.staffId,
    refundMethod: cn.refundMethod,
    lines: cn.lines.map((l) => ({
      lineId: l.lineId, sku: l.sku, hsn: l.hsn, rateBps: l.rateBps, amountPaise: l.amountPaise,
      taxablePaise: l.taxablePaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, restock: l.restock.type,
    })),
    totals: cn.totals,
    shopify: cn.posted && { refundId: cn.posted.refundRef },
    lastError: cn.lastError,
    cancelReason: cn.cancelReason,
  };
}

export function refundRoutes(refunds: Refunds): Router {
  const r = Router();
  // POST /bills/:invoiceNo/refund {staffId, reasonCode, note?}  -> full refund
  r.post("/bills/:invoiceNo/refund", async (req, res) => {
    const cn = await refunds.refundInFull(req.params.invoiceNo, RefundBody.parse(req.body));
    res.status(cn.status === "POSTED" ? 201 : cn.status === "CANCELLED" ? 409 : 202).json(creditNoteView(cn));
  });
  r.get("/bills/:invoiceNo/refunds", (req, res) => {
    res.json(refunds.forInvoice(req.params.invoiceNo).map(creditNoteView));
  });
  r.get("/credit-notes/:creditNoteNo", (req, res) => {
    res.json(creditNoteView(refunds.get(req.params.creditNoteNo)));
  });
  r.post("/credit-notes/:creditNoteNo/resume", async (req, res) => {
    res.json(creditNoteView(await refunds.resume(req.params.creditNoteNo)));
  });
  return r;
}
