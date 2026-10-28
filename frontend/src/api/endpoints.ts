import { enc, get, request } from "./client";
import type {
  Bill, BillSummary, Cart, Channel, CreditNote, CustomerLookup, DayEndReport, Frame, LensMatrix, PaymentMethod, Quote, ReasonCodes, Staff, Store,
} from "./types";

export const api = {
  stores: () => get<Store[]>("/stores"),
  staff: (store: string) => get<Staff[]>(`/stores/${enc(store)}/staff`),
  frames: (store: string) => get<Frame[]>(`/catalog/frames?store=${enc(store)}`),
  reasonCodes: () => get<ReasonCodes>("/config/reason-codes"),

  customer: (phone: string) => get<CustomerLookup>(`/customers?phone=${enc(phone)}`),
  lenses: (phone: string) => get<LensMatrix>(`/catalog/lenses?phone=${enc(phone)}`),

  createCart: (body: { phone: string; storeCode: string; staffId: string; channel: Channel }) => request<Cart>("POST", "/carts", { body }).then((r) => r.data),
  cart: (id: string) => get<Cart>(`/carts/${enc(id)}`),
  addPair: (id: string, body: { frameVariantId?: string; lensVariantId?: string }) => request<Cart>("POST", `/carts/${enc(id)}/pairs`, { body }).then((r) => r.data),
  removePair: (id: string, pairRef: string) => request<Cart>("DELETE", `/carts/${enc(id)}/pairs/${enc(pairRef)}`).then((r) => r.data),
  quote: (id: string) => get<Quote>(`/carts/${enc(id)}/quote`),
  setManagerDiscount: (id: string, body: { approverId: string; reasonCode: string; bps: number }) => request<Cart>("PUT", `/carts/${enc(id)}/manager-discount`, { body }).then((r) => r.data),
  clearManagerDiscount: (id: string) => request<Cart>("DELETE", `/carts/${enc(id)}/manager-discount`).then((r) => r.data),

  /** 201 POSTED, 202 still in progress, 402 declined: all carry a bill. Not retried by the browser. */
  checkout: (id: string, paymentMethod: PaymentMethod) => request<Bill>("POST", `/carts/${enc(id)}/checkout`, { body: { paymentMethod }, accept: [202, 402] }),
  cartBill: (id: string) => get<Bill>(`/carts/${enc(id)}/bill`),
  bill: (invoiceNo: string) => get<Bill>(`/bills/${enc(invoiceNo)}`),
  resumeBill: (invoiceNo: string) => request<Bill>("POST", `/bills/${enc(invoiceNo)}/resume`, { accept: [202, 402] }),
  cancelBill: (invoiceNo: string, staffId: string, reason: string) => request<Bill>("POST", `/bills/${enc(invoiceNo)}/cancel`, { body: { staffId, reason } }).then((r) => r.data),
  recentBills: (store: string, limit = 25) => get<BillSummary[]>(`/bills?store=${enc(store)}&limit=${limit}`),

  /** 201 POSTED, 202 in progress, 409 cancelled (nothing refunded). Not retried by the browser. */
  refund: (invoiceNo: string, body: { staffId: string; reasonCode: string; note?: string }) => request<CreditNote>("POST", `/bills/${enc(invoiceNo)}/refund`, { body, accept: [202, 409] }),
  refundsFor: (invoiceNo: string) => get<CreditNote[]>(`/bills/${enc(invoiceNo)}/refunds`),
  creditNote: (no: string) => get<CreditNote>(`/credit-notes/${enc(no)}`),
  resumeRefund: (no: string) => request<CreditNote>("POST", `/credit-notes/${enc(no)}/resume`).then((r) => r.data),

  dayEnd: (store: string, date: string) => get<DayEndReport>(`/reports/day-end?store=${enc(store)}&date=${enc(date)}`),
};
