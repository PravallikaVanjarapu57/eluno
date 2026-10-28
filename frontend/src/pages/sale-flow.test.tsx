// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Route, Routes, MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import type { Cart } from "../api/types";
import { authMock, customer, fake, LocationProbe, renderAt, rx, sessionMock } from "../test-utils";

vi.mock("../api/endpoints", () => ({
  api: {
    customerById: vi.fn(), prescriptions: vi.fn(), customerBills: vi.fn(), eligiblePrescriptions: vi.fn(),
    createCart: vi.fn(), cart: vi.fn(), selectCartPrescription: vi.fn(),
  },
}));
vi.mock("../state/auth", () => authMock());
vi.mock("../state/session", () => sessionMock());
import { api } from "../api/endpoints";
import CustomerProfilePage from "./CustomerProfilePage";
import StartSalePage, { SAVED } from "./StartSalePage";

const view = { customer: customer(), name: "Priya Nair", flags: { priority: false, family: false, campaigns: [] } };
const cart = (over: Partial<Cart> = {}): Cart => ({
  id: "cart-1", status: "open", storeCode: "HSR", staffId: "S105", channel: "walk_in", selectedRxId: null, rxSelection: "explicit",
  customer: { id: "80001000", name: "Priya Nair", phone: "+919000000000", tags: [] }, pairs: [], manualDiscount: null, mrpTotalPaise: 0, ...over,
});
const sale = () => renderAt("/customers/80001000/sale", "/customers/:id/sale", <StartSalePage />);

beforeEach(() => {
  vi.clearAllMocks();
  fake.perms = ["customer:view", "customer:create", "customer:update", "prescription:create", "billing:use"];
  fake.store = "HSR";
  vi.mocked(api.customerById).mockResolvedValue(view);
  vi.mocked(api.createCart).mockResolvedValue(cart());
  vi.mocked(api.selectCartPrescription).mockImplementation(async (_id, rxId) => cart({ selectedRxId: rxId }));
});

describe("customer profile", () => {
  const profile = () => renderAt("/customers/80001000", "/customers/:id", <CustomerProfilePage />);

  it("shows contact details, prescription history with statuses, and recent bills", async () => {
    vi.mocked(api.prescriptions).mockResolvedValue([rx("RX2"), rx("RX1", "expired")]);
    vi.mocked(api.customerBills).mockResolvedValue([{ invoiceNo: "ELU/HSR/FY26/00003", status: "POSTED", storeCode: "HSR", invoiceDate: "2026-10-23", createdAt: "2026-10-23T10:00:00+05:30", payablePaise: 520000 }]);
    profile();
    expect(await screen.findByRole("heading", { name: "Priya Nair" })).toBeTruthy();
    expect(screen.getByText("priya@example.com")).toBeTruthy();
    expect(await screen.findByRole("article", { name: "Prescription RX2" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Prescription RX1" }).textContent).toMatch(/Expired/);
    expect(screen.getByText("ELU/HSR/FY26/00003")).toBeTruthy();
    expect(screen.getByText("₹5,200.00")).toBeTruthy();
  });

  it("with no prescriptions, says so and offers to add one", async () => {
    vi.mocked(api.prescriptions).mockResolvedValue([]);
    vi.mocked(api.customerBills).mockResolvedValue([]);
    profile();
    expect(await screen.findByText("No prescription on file")).toBeTruthy();
    expect(screen.getByText("No bills at your stores yet.")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: "Add prescription" })[0]!);
    expect(screen.getByTestId("location").textContent).toBe("/customers/80001000/prescriptions/new");
  });

  it("one failing section does not hide the others, and retries on its own", async () => {
    vi.mocked(api.prescriptions).mockRejectedValueOnce(new ApiError(503, "RX_UNAVAILABLE", "The store tool is not responding."));
    vi.mocked(api.customerBills).mockResolvedValue([]);
    profile();
    expect(await screen.findByText("The store tool is not responding.")).toBeTruthy();
    expect(screen.getByText("priya@example.com")).toBeTruthy();
    vi.mocked(api.prescriptions).mockResolvedValue([rx("RX9")]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "Prescription RX9" })).toBeTruthy();
  });

  it("an unknown customer is a clear 'not found'", async () => {
    vi.mocked(api.customerById).mockRejectedValue(new ApiError(404, "CUSTOMER_NOT_FOUND", "No customer."));
    vi.mocked(api.prescriptions).mockResolvedValue([]);
    vi.mocked(api.customerBills).mockResolvedValue([]);
    profile();
    expect(await screen.findByText("Customer not found")).toBeTruthy();
  });

  it("starts a sale from the profile", async () => {
    vi.mocked(api.prescriptions).mockResolvedValue([]);
    vi.mocked(api.customerBills).mockResolvedValue([]);
    profile();
    await userEvent.click(await screen.findByRole("button", { name: "Start sale" }));
    expect(screen.getByTestId("location").textContent).toBe("/customers/80001000/sale");
  });

  it("shows only what the role may do", async () => {
    fake.perms = ["customer:view"];
    vi.mocked(api.prescriptions).mockResolvedValue([]);
    vi.mocked(api.customerBills).mockResolvedValue([]);
    profile();
    await screen.findByRole("heading", { name: "Priya Nair" });
    expect(screen.queryByRole("button", { name: "Edit customer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start sale" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add prescription" })).toBeNull();
  });
});

describe("start sale", () => {
  it("creates the cart for this customer by id (no phone lookup), and remembers it on the device", async () => {
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([rx("RX1", "expired")]);
    sale();
    await screen.findByText("No prescription in force");
    expect(api.createCart).toHaveBeenCalledWith({ customerId: "80001000", storeCode: "HSR", channel: "walk_in" });
    expect(api.createCart).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(SAVED)!)).toEqual({ cartId: "cart-1", phone: "+919000000000", customerId: "80001000" });
  });

  it("with several prescriptions in force it makes staff choose: no guess, no continuing until they do", async () => {
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([rx("RX2"), rx("RX1")]);
    sale();
    expect(await screen.findByText("Choose one")).toBeTruthy();
    const go = screen.getByRole("button", { name: /Continue/ }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(api.selectCartPrescription).not.toHaveBeenCalled();

    const [, second] = screen.getAllByRole("radio");
    await userEvent.click(second!);
    expect(api.selectCartPrescription).toHaveBeenCalledWith("cart-1", "RX1");
    await waitFor(() => expect((screen.getByRole("button", { name: "Continue to frames and lenses" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Continue to frames and lenses" }));
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("an expired prescription is shown but cannot be selected", async () => {
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([rx("RX2"), rx("RX1", "expired")]);
    sale();
    await screen.findByRole("article", { name: "Prescription RX1" });
    expect(screen.getByRole("article", { name: "Prescription RX1" }).textContent).toMatch(/Expired on 2026-01-01/);
    expect(screen.getAllByRole("radio")).toHaveLength(1); // only RX2 can be chosen
    expect(screen.getByText("Cannot be used")).toBeTruthy();
  });

  it("a single prescription in force is used without asking", async () => {
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([rx("RX1")]);
    sale();
    await waitFor(() => expect(api.selectCartPrescription).toHaveBeenCalledWith("cart-1", "RX1"));
    expect(api.selectCartPrescription).toHaveBeenCalledTimes(1);
  });

  it("with no prescription it offers to add one and come back, and lets frames be billed", async () => {
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([]);
    sale();
    expect(await screen.findByText("No prescription on file")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue without a prescription" }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Add prescription" }));
    expect(screen.getByTestId("location").textContent).toBe("/customers/80001000/prescriptions/new?returnTo=sale");
  });

  it("coming back after adding a prescription finds the same cart instead of starting another", async () => {
    localStorage.setItem(SAVED, JSON.stringify({ cartId: "cart-1", phone: "+919000000000", customerId: "80001000" }));
    vi.mocked(api.cart).mockResolvedValue(cart({ pairs: [{ pairRef: "1", frame: { variantId: "1", sku: "F1", title: "Frame", hsn: "9003", pricePaise: 100000 }, lens: null }] }));
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([rx("RX9"), rx("RX1")]);
    sale();
    await screen.findByText("Choose one");
    expect(api.cart).toHaveBeenCalledWith("cart-1");
    expect(api.createCart).not.toHaveBeenCalled();
  });

  it("keeps the cart's earlier choice when returning", async () => {
    localStorage.setItem(SAVED, JSON.stringify({ cartId: "cart-1", phone: "+919000000000", customerId: "80001000" }));
    vi.mocked(api.cart).mockResolvedValue(cart({ selectedRxId: "RX1" }));
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([rx("RX2"), rx("RX1")]);
    sale();
    expect(await screen.findByText("Selected for this sale")).toBeTruthy();
    expect(screen.queryByText("Choose one")).toBeNull();
    expect((screen.getByRole("button", { name: "Continue to frames and lenses" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not silently replace an unfinished sale for someone else", async () => {
    localStorage.setItem(SAVED, JSON.stringify({ cartId: "other", phone: "+919111111111", customerId: "55" }));
    vi.mocked(api.cart).mockResolvedValue(cart({ id: "other", customer: { id: "55", name: "Someone Else", phone: "+919111111111", tags: [] }, pairs: [{ pairRef: "1", frame: null, lens: null }] }));
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([]);
    sale();
    expect(await screen.findByText("A sale for Someone Else is still open on this till")).toBeTruthy();
    expect(api.createCart).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SAVED)!).cartId).toBe("other");
  });

  it("a server refusal to select shows its message and keeps the cart", async () => {
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([rx("RX2"), rx("RX1")]);
    vi.mocked(api.selectCartPrescription).mockRejectedValue(new ApiError(422, "RX_NOT_IN_FORCE", "RX1 expired on 2026-01-01. Book an eye test before billing a lens."));
    sale();
    await screen.findByText("Choose one");
    await userEvent.click(screen.getAllByRole("radio")[0]!);
    expect(await screen.findByText(/RX1 expired on 2026-01-01/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue/ })).toHaveProperty("disabled", true);
  });

  it("without a store it asks for one and creates nothing", async () => {
    fake.store = "";
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([]);
    sale();
    expect(await screen.findByText("Choose a store")).toBeTruthy();
    expect(api.createCart).not.toHaveBeenCalled();
  });
});

describe("the whole detour", () => {
  it("sale -> add prescription -> back on the same sale (location round trip)", async () => {
    vi.mocked(api.eligiblePrescriptions).mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/customers/80001000/sale"]}>
        <Routes>
          <Route path="/customers/:id/sale" element={<StartSalePage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Add prescription" }));
    expect(screen.getByTestId("location").textContent).toContain("returnTo=sale");
    expect(JSON.parse(localStorage.getItem(SAVED)!).cartId).toBe("cart-1"); // the cart is remembered across the detour
  });
});
