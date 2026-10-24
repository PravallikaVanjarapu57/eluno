import { buildDayEnd, type DayEndReport } from "../domain/dayEnd.js";
import { DomainError } from "../domain/errors.js";
import type { BillRepository, Clock, CreditNoteRepository, SalesLedger, StoreDirectory } from "../ports/index.js";

export class DayEnd {
  constructor(
    private readonly d: {
      ledger: SalesLedger;
      stores: StoreDirectory;
      bills: BillRepository;
      creditNotes: CreditNoteRepository;
      clock: Clock;
      /** How far back to look for orders whose refunds may land on the report date. */
      refundLookbackDays?: number;
    },
  ) {}

  async report(storeCode: string, date = this.d.clock.today()): Promise<DayEndReport> {
    const store = await this.d.stores.getStore(storeCode);
    if (!store || !store.active) throw new DomainError("STORE_NOT_FOUND", `${storeCode} is not an active store.`, { storeCode });
    const since = shiftDate(date, -(this.d.refundLookbackDays ?? 90));
    const orders = await this.d.ledger.ordersSince(store, since);
    return buildDayEnd({
      storeCode: store.code,
      date,
      orders,
      bills: this.d.bills.listForStore(store.code),
      creditNotes: this.d.creditNotes.listForStore(store.code),
    });
  }
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
