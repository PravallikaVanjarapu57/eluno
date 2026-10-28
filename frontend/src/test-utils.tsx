import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import type { Customer, CustomerRow, Permission, RxView, Prescription } from "./api/types";

/** What `useAuth` / `useSession` return in component tests. Tests change `perms` and `store` per case. */
export const fake = {
  perms: ["customer:view", "customer:create", "customer:update", "prescription:create", "billing:use"] as Permission[],
  store: "HSR",
};
export const authMock = () => ({
  useAuth: () => ({ status: "signedIn", user: { username: "s105", staffId: "S105", name: "Vikram R.", role: "salesperson", storeCodes: ["HSR"], permissions: fake.perms }, can: (p: Permission) => fake.perms.includes(p), notice: null, login: vi.fn(), logout: vi.fn() }),
});
export const sessionMock = () => ({
  useSession: () => ({ stores: [{ code: "HSR", name: "Eluno HSR Layout", invoicePrefix: "HSR" }], reasonCodes: null, storeCode: fake.store, setStoreCode: vi.fn(), error: null, reload: vi.fn(), store: fake.store ? { code: "HSR", name: "Eluno HSR Layout", invoicePrefix: "HSR" } : undefined }),
});

export function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

/** Render a page at a URL, with a probe that shows where the app navigated to. */
export function renderAt(path: string, routePath: string, ui: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePath} element={ui} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const eye = { sph: -2, cyl: 0, axis: null, add: null };
export const customer = (over: Partial<Customer> = {}): Customer => ({ id: "80001000", firstName: "Priya", lastName: "Nair", phone: "+919000000000", email: "priya@example.com", tags: [], lifetimeSpendPaise: 0, ordersCount: 0, ...over });
export const row = (over: Partial<CustomerRow> = {}): CustomerRow => ({ customer: customer(), flags: { priority: false, family: false, campaigns: [] }, prescriptions: { count: 2, latest: { rxId: "RX1", testedOn: "2026-09-01", validUntil: "2027-09-01", status: "valid" } }, ...over });
export const rx = (id: string, status: RxView["status"] = "valid", over: Partial<Prescription> = {}): RxView => ({
  rx: { rxId: id, customerId: "80001000", testedOn: "2026-09-01", validUntil: status === "expired" ? "2026-01-01" : "2027-09-01", source: "external", optometristId: null, od: eye, os: { ...eye, sph: -1.5 }, pd: { binocular: 62, monoR: null, monoL: null }, notes: null, ...over },
  status, warnings: [], eligible: status === "valid", reason: status === "expired" ? "Expired on 2026-01-01. Book an eye test before billing a lens." : null,
});
