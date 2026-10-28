import type { Cart } from "../../domain/cart.js";
import type { CartRepository } from "../../ports/index.js";
import type { Db } from "./db.js";

// Carts are saved on every change so a dropped connection or a restarted till does not lose a bill in progress.
export class SqliteCartRepository implements CartRepository {
  constructor(private readonly db: Db) {}

  get(id: string): Cart | null {
    const row = this.db.prepare("SELECT cart_json FROM carts WHERE cart_id = ?").get(id) as { cart_json: string } | undefined;
    return row ? (JSON.parse(row.cart_json) as Cart) : null;
  }

  save(cart: Cart): void {
    this.db
      .prepare(
        `INSERT INTO carts (cart_id, store_code, status, cart_json, updated_at) VALUES (@id, @storeCode, @status, @json, @updatedAt)
         ON CONFLICT (cart_id) DO UPDATE SET status = excluded.status, cart_json = excluded.cart_json, updated_at = excluded.updated_at`,
      )
      .run({ id: cart.id, storeCode: cart.storeCode, status: cart.status, json: JSON.stringify(cart), updatedAt: cart.updatedAt });
  }
}
