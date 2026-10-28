import { z } from "zod";
import type { ChargeResult, PaymentTerminal, RefundResult } from "../../ports/index.js";
import type { Paise } from "../../domain/money.js";
import { AmbiguousWriteError, HttpError, parseUpstream, RetriesExhaustedError, type HttpClient } from "../http/client.js";

const ChargeSchema = z.object({ charge_id: z.string(), status: z.string(), amount_paise: z.number().int() });
const ChargeStatusSchema = ChargeSchema.extend({ refunded_paise: z.number().int() });
const RefundSchema = z.object({ refund_id: z.string(), status: z.string() });

/** Razorpay-like card/UPI terminal. Idempotent on order_ref, so retries reuse the invoice number. */
export class TerminalClient implements PaymentTerminal {
  constructor(private readonly http: HttpClient) {}

  async charge(req: { orderRef: string; amountPaise: Paise; method: "upi" | "card" }): Promise<ChargeResult> {
    try {
      const res = await this.http.post("terminal/charges", { amount_paise: req.amountPaise, method: req.method, order_ref: req.orderRef }, { idempotent: true });
      const c = parseUpstream("terminal", "charge", ChargeSchema, res.body);
      if (c.status !== "captured") return { outcome: "declined", reason: `Payment ${c.status}.` };
      if (c.amount_paise !== req.amountPaise) return { outcome: "unknown", reason: `Terminal captured ${c.amount_paise} paise for ${req.orderRef}, expected ${req.amountPaise}.` };
      return { outcome: "captured", chargeId: c.charge_id };
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return { outcome: "declined", reason: `Terminal refused the charge: ${JSON.stringify(e.body)}` };
      if (e instanceof RetriesExhaustedError || e instanceof AmbiguousWriteError) return { outcome: "unknown", reason: e.message };
      throw e;
    }
  }

  /**
   * The terminal has no idempotency key for refunds, so a blind retry could pay out twice.
   * Instead: read how much this charge has already had refunded, and only send what is still owed.
   * (Full refunds only in v1: "already refunded >= amount" means this refund already happened.)
   */
  async refund(req: { chargeId: string; amountPaise: Paise; reason: string }): Promise<RefundResult> {
    let status;
    try {
      status = parseUpstream("terminal", "charge", ChargeStatusSchema, (await this.http.get(`terminal/charges/${req.chargeId}`)).body);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { outcome: "rejected", reason: `Terminal has no charge ${req.chargeId}.` };
      if (e instanceof RetriesExhaustedError) return { outcome: "unknown", reason: e.message };
      throw e;
    }
    if (status.refunded_paise >= req.amountPaise) return { outcome: "refunded", refundRef: null };
    if (status.refunded_paise > 0) return { outcome: "rejected", reason: `Charge ${req.chargeId} is already partly refunded (${status.refunded_paise} paise); settle it manually.` };

    try {
      const res = await this.http.post("terminal/refunds", { charge_id: req.chargeId, amount_paise: req.amountPaise, reason: req.reason });
      const r = parseUpstream("terminal", "refund", RefundSchema, res.body);
      return r.status === "processed" ? { outcome: "refunded", refundRef: r.refund_id } : { outcome: "rejected", reason: `Refund ${r.status}.` };
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return { outcome: "rejected", reason: `Terminal refused the refund: ${JSON.stringify(e.body)}` };
      if (e instanceof AmbiguousWriteError || e instanceof RetriesExhaustedError) return { outcome: "unknown", reason: e.message };
      throw e;
    }
  }
}
