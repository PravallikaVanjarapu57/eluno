// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authMock, customer, fake, renderAt, rx, sessionMock } from "../test-utils";

vi.mock("../api/endpoints", () => ({ api: { customerById: vi.fn(), addPrescription: vi.fn() } }));
vi.mock("../state/auth", () => authMock());
vi.mock("../state/session", () => sessionMock());
import { api } from "../api/endpoints";
import { AddPrescriptionPage } from "./CustomerFormPages";

beforeEach(() => {
  vi.clearAllMocks();
  fake.perms = ["customer:view", "prescription:create", "billing:use"];
  vi.mocked(api.customerById).mockResolvedValue({ customer: customer(), name: "Priya Nair", flags: { priority: false, family: false, campaigns: [] } });
  vi.mocked(api.addPrescription).mockResolvedValue(rx("RX5100"));
  localStorage.setItem("eluno.sale", JSON.stringify({ cartId: "cart-1", phone: "+919000000000", customerId: "80001000" }));
});

async function save(url: string) {
  renderAt(url, "/customers/:id/prescriptions/new", <AddPrescriptionPage />);
  await userEvent.type(await screen.findByLabelText("Right eye (OD) SPH"), "-2");
  await userEvent.type(screen.getByLabelText("Left eye (OS) SPH"), "-1.5");
  await userEvent.click(screen.getByRole("button", { name: "Save prescription" }));
}

describe("AddPrescriptionPage", () => {
  it("opened from a sale, it returns to that sale and the saved cart is untouched", async () => {
    await save("/customers/80001000/prescriptions/new?returnTo=sale");
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/customers/80001000/sale"));
    expect(JSON.parse(localStorage.getItem("eluno.sale")!).cartId).toBe("cart-1");
  });

  it("opened from the profile, it returns to the profile", async () => {
    await save("/customers/80001000/prescriptions/new");
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/customers/80001000"));
  });

  it("cancel goes back without saving", async () => {
    renderAt("/customers/80001000/prescriptions/new?returnTo=sale", "/customers/:id/prescriptions/new", <AddPrescriptionPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("location").textContent).toBe("/customers/80001000/sale");
    expect(api.addPrescription).not.toHaveBeenCalled();
  });
});
