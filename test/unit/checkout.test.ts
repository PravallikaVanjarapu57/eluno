import { beforeEach, describe, expect, it } from "vitest";
import { Checkout } from "../../src/application/checkout.js";
import { openDb } from "../../src/adapters/sqlite/db.js";
import { SqliteBillRepository } from "../../src/adapters/sqlite/billRepo.js";
import { SqliteAuditLog } from "../../src/adapters/sqlite/auditLog.js";
import { SqliteCartRepository } from "../../src/adapters/sqlite/cartRepo.js";
import { loadPosConfig } from "../../src/config/load.js";
import { TaxTable } from "../../src/domain/tax.js";
import type { Bill, PostedOrder } from "../../src/domain/bill.js";
import type { Store } from "../../src/domain/store.js";
import { OrderOutcomeUnknown, OrderRejected, type ChargeResult, type OrderSink, type PaymentTerminal } from "../../src/ports/index.js";
import { cart, customer, eye, frame, lens, rx } from "../support/fixtures.js";

const cfg = loadPosConfig("config");
const HSR: Store = { code: "HSR", name: "Eluno HSR Layout", locationRef: "70000002", invoicePrefix: "ELU/HSR/FY26/", stateCode: "29", active: true };

/** Shopify stand-in. `script` decides what each createOrder call does. */
class FakeShopify implements OrderSink {
  orders: Bill[] = [];
  script: ("ok" | "write-then-timeout" | "timeout" | "reject")[] = [];
  creates = 0;
  async createOrder(bill: Bill): Promise<PostedOrder> {
    this.creates++;
    const step = this.script.shift() ?? "ok";
    if (step === "timeout") throw new OrderOutcomeUnknown("timeout before write");
    if (step === "reject") throw new OrderRejected("Shopify refused the order: FR-0003 only 0 available");
    this.orders.push(bill);
    if (step === "write-then-timeout") throw new OrderOutcomeUnknown("timeout after write");
    return this.posted(bill);
  }
  async findOrderByInvoiceNo(bill: Bill) {
    const o = this.orders.find((x) => x.invoiceNo === bill.invoiceNo);
    return o ? this.posted(o) : null;
  }
  async maxInvoiceSeq() {
    return 2; // HSR already issued 00001 and 00002 on the old POS
  }
  async maxCreditNoteSeq() {
    return 0;
  }
  async calculateRefund(): Promise<never> {
    throw new Error("not used");
  }
  async createRefund(): Promise<never> {
    throw new Error("not used");
  }
  async findRefund() {
    return null;
  }
  private posted(b: Bill): PostedOrder {
    const n = this.orders.indexOf(b);
    return { orderRef: String(95000100 + n), orderName: `#${2000 + n}`, saleTransactionRef: "tx-1", lineRefs: Object.fromEntries(b.lines.map((l, i) => [l.lineId, String(96000100 + i)])) };
  }
}

/** Idempotent on orderRef like the real terminal. */
class FakeTerminal implements PaymentTerminal {
  calls: { orderRef: string; amountPaise: number }[] = [];
  script: ChargeResult["outcome"][] = [];
  private captured = new Map<string, string>();
  async charge(req: { orderRef: string; amountPaise: number }): Promise<ChargeResult> {
    this.calls.push(req);
    const step = this.script.shift() ?? "captured";
    if (step === "unknown") return { outcome: "unknown", reason: "terminal timeout" };
    if (step === "declined") return { outcome: "declined", reason: "insufficient funds" };
    if (!this.captured.has(req.orderRef)) this.captured.set(req.orderRef, `chg_${this.captured.size + 1}`);
    return { outcome: "captured", chargeId: this.captured.get(req.orderRef)! };
  }
  async refund(): Promise<never> {
    throw new Error("not used");
  }
}

let shopify: FakeShopify;
let terminal: FakeTerminal;
let checkout: Checkout;
let carts: SqliteCartRepository;
let bills: SqliteBillRepository;
let audit: SqliteAuditLog;
let stock: number;

function newCart(id = "cart-1") {
  carts.save(cart({
    id,
    customer: customer({ id: "80001005", tags: ["campaign:progressive_oct26", "priority"] }),
    pairs: [{ pairRef: "1", frame: frame(), lens: { item: lens("progressive", 1.6, "blue_cut", { pricePaise: 949900 }), rx: rx({ customerId: "80001005", od: eye(-3.25, 0, 2.5), os: eye(-3.25, 0, 2.5) }) } }],
  }));
  return id;
}

beforeEach(() => {
  const db = openDb(":memory:");
  shopify = new FakeShopify();
  terminal = new FakeTerminal();
  carts = new SqliteCartRepository(db);
  bills = new SqliteBillRepository(db);
  audit = new SqliteAuditLog(db);
  stock = 2;
  checkout = new Checkout({
    carts, bills, audit, orders: shopify, terminal,
    stores: { getStore: async () => HSR },
    stock: { available: async () => stock },
    clock: { now: () => new Date("2026-10-23T06:30:00Z"), today: () => "2026-10-23" },
    offers: cfg.offers,
    taxes: new TaxTable(cfg.taxRates),
    sleep: async () => {},
  });
});

describe("Checkout", () => {
  it("numbers, charges and posts; the series continues after the old POS", async () => {
    const bill = await checkout.checkout(newCart(), "upi");
    expect(bill).toMatchObject({ invoiceNo: "ELU/HSR/FY26/00003", status: "POSTED", payment: { method: "upi", amountPaise: 1869700, chargeId: "chg_1" }, posted: { orderName: "#2000" } });
    expect(terminal.calls).toEqual([{ orderRef: "ELU/HSR/FY26/00003", amountPaise: 1869700, method: "upi" }]);
    expect(carts.get("cart-1")!.status).toBe("checked_out");
    expect(audit.forRef(bill.invoiceNo).map((e) => e.action)).toEqual(["bill.numbered", "bill.paid", "bill.posted"]);
  });

  it("Shopify wrote the order but the response was lost: the retry finds it instead of creating a second one", async () => {
    shopify.script = ["write-then-timeout"];
    const bill = await checkout.checkout(newCart(), "upi");
    expect(bill.status).toBe("POSTED");
    expect(shopify.orders).toHaveLength(1);
    expect(shopify.creates).toBe(1);
    expect(audit.forRef(bill.invoiceNo).at(-1)!.payload).toMatchObject({ adopted: true });
  });

  it("Shopify down: the bill is kept as paid-not-posted, and the recovery sweep posts it exactly once", async () => {
    shopify.script = ["timeout", "timeout", "timeout"];
    const bill = await checkout.checkout(newCart(), "upi");
    expect(bill).toMatchObject({ status: "CHARGED_NOT_POSTED", lastError: expect.stringMatching(/timeout/) });
    expect(shopify.orders).toHaveLength(0);

    const [recovered] = await checkout.resumePending();
    expect(recovered!.status).toBe("POSTED");
    expect(shopify.orders).toHaveLength(1);
    expect(terminal.calls).toHaveLength(1); // never charged again
    expect(await checkout.resumePending()).toEqual([]);
  });

  it("Shopify refuses the order: no blind retry; money is safe and the error is kept for staff", async () => {
    shopify.script = ["reject"];
    const bill = await checkout.checkout(newCart(), "upi");
    expect(bill).toMatchObject({ status: "CHARGED_NOT_POSTED", lastError: expect.stringMatching(/refused/) });
    expect(shopify.creates).toBe(1);
  });

  it("terminal outcome unknown: the bill waits; resume retries with the same order_ref and charges once", async () => {
    terminal.script = ["unknown"];
    const first = await checkout.checkout(newCart(), "upi");
    expect(first).toMatchObject({ status: "NUMBERED", lastError: expect.stringMatching(/Payment status unknown/) });
    expect(await checkout.resumePending()).toEqual([]); // the sweep never charges

    const resumed = await checkout.resume(first.invoiceNo);
    expect(resumed.status).toBe("POSTED");
    expect(terminal.calls.map((c) => c.orderRef)).toEqual([first.invoiceNo, first.invoiceNo]);
  });

  it("declined: the number is cancelled but stays in the series; the cart reopens; the next bill takes the next number", async () => {
    terminal.script = ["declined"];
    const declined = await checkout.checkout(newCart(), "card");
    expect(declined).toMatchObject({ invoiceNo: "ELU/HSR/FY26/00003", status: "CANCELLED", cancelReason: expect.stringMatching(/insufficient funds/) });
    expect(carts.get("cart-1")!.status).toBe("open");

    const paid = await checkout.checkout("cart-1", "upi");
    expect(paid).toMatchObject({ invoiceNo: "ELU/HSR/FY26/00004", status: "POSTED" });
    expect(bills.listForStore("HSR").map((b) => [b.invoiceNo, b.status])).toEqual([
      ["ELU/HSR/FY26/00003", "CANCELLED"],
      ["ELU/HSR/FY26/00004", "POSTED"],
    ]);
  });

  it("pressing charge twice returns the same bill: one number, one charge, one order", async () => {
    const id = newCart();
    const [a, b] = await Promise.all([checkout.checkout(id, "upi"), checkout.checkout(id, "upi")]);
    const again = await checkout.checkout(id, "upi");
    expect(new Set([a.invoiceNo, b.invoiceNo, again.invoiceNo])).toEqual(new Set(["ELU/HSR/FY26/00003"]));
    expect(shopify.orders).toHaveLength(1);
    expect(new Set(terminal.calls.map((c) => c.orderRef)).size).toBe(1);
  });

  it("cash: no terminal, no charge id", async () => {
    const bill = await checkout.checkout(newCart(), "cash");
    expect(bill).toMatchObject({ status: "POSTED", payment: { method: "cash", chargeId: null, amountPaise: 1869700 } });
    expect(terminal.calls).toEqual([]);
  });

  it("stock re-checked before taking money; a failed check does not use a number", async () => {
    stock = 0;
    await expect(checkout.checkout(newCart(), "upi")).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
    expect(terminal.calls).toEqual([]);
    stock = 2;
    expect((await checkout.checkout("cart-1", "upi")).invoiceNo).toBe("ELU/HSR/FY26/00003");
  });

  it("only an unpaid bill can be cancelled", async () => {
    terminal.script = ["unknown"];
    const pending = await checkout.checkout(newCart(), "upi");
    expect(checkout.cancel(pending.invoiceNo, "S108", "customer left").status).toBe("CANCELLED");

    const posted = await checkout.checkout(newCart("cart-2"), "upi");
    expect(() => checkout.cancel(posted.invoiceNo, "S108", "oops")).toThrow(expect.objectContaining({ code: "BILL_NOT_CANCELLABLE" }));
  });

  it("an empty cart cannot be billed", async () => {
    carts.save(cart({ id: "empty" }));
    await expect(checkout.checkout("empty", "upi")).rejects.toMatchObject({ code: "PAIR_EMPTY" });
  });
});
