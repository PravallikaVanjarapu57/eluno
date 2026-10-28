import { DomainError } from "../domain/errors.js";
import type { FrameItem } from "../domain/catalog.js";
import type { ReasonCode } from "../domain/offers/offer.js";
import type { Staff, Store } from "../domain/store.js";
import type { FrameListing, StaffDirectory, StoreDirectory, StoreListing } from "../ports/index.js";

/** Read-only reference data a till screen needs to offer choices instead of free-typed ids. */
export class Reference {
  constructor(
    private readonly d: {
      stores: StoreListing & StoreDirectory;
      frames: FrameListing;
      staff: StaffDirectory;
      reasonCodes: { discount: readonly ReasonCode[]; refund: readonly ReasonCode[] };
    },
  ) {}

  stores(): Promise<Store[]> {
    return this.d.stores.listStores();
  }

  async staff(storeCode: string): Promise<Staff[]> {
    await this.store(storeCode);
    return this.d.staff.listByStore(storeCode);
  }

  async frames(storeCode: string): Promise<(FrameItem & { available: number })[]> {
    return this.d.frames.listFrames(await this.store(storeCode));
  }

  reasonCodes() {
    return this.d.reasonCodes;
  }

  private async store(code: string): Promise<Store> {
    const store = await this.d.stores.getStore(code);
    if (!store || !store.active) throw new DomainError("STORE_NOT_FOUND", `${code} is not an active store.`, { storeCode: code });
    return store;
  }
}
