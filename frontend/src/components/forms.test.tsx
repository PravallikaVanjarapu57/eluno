// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import { customer, rx } from "../test-utils";

vi.mock("../api/endpoints", () => ({ api: { createCustomer: vi.fn(), updateCustomer: vi.fn(), customer: vi.fn(), addPrescription: vi.fn() } }));
import { api } from "../api/endpoints";
import { CustomerForm } from "./CustomerForm";
import { PrescriptionForm } from "./PrescriptionForm";

const type = userEvent.type;
beforeEach(() => vi.clearAllMocks());

describe("CustomerForm (create)", () => {
  const setup = () => {
    const h = { onSaved: vi.fn(), onCancel: vi.fn(), onUseExisting: vi.fn() };
    render(<CustomerForm mode="create" {...h} />);
    return h;
  };

  it("explains each missing or malformed field and sends nothing", async () => {
    setup();
    await type(screen.getByLabelText(/Mobile number/), "12345");
    await type(screen.getByLabelText(/^Email/), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Create customer" }));
    expect(screen.getByText("Enter a 10-digit Indian mobile number.")).toBeTruthy();
    expect(screen.getByText("First name is required.")).toBeTruthy();
    expect(screen.getByText("That does not look like an email address.")).toBeTruthy();
    expect(api.createCustomer).not.toHaveBeenCalled();
  });

  it("creates once even if the button is hit twice, trimming what was typed", async () => {
    let done!: (v: unknown) => void;
    vi.mocked(api.createCustomer).mockReturnValue(new Promise((r) => { done = r; }) as never);
    const h = setup();
    await type(screen.getByLabelText(/Mobile number/), "90000 12345");
    await type(screen.getByLabelText(/First name/), "  Asha ");
    const btn = screen.getByRole("button", { name: "Create customer" });
    await userEvent.dblClick(btn);
    expect(api.createCustomer).toHaveBeenCalledTimes(1);
    expect(api.createCustomer).toHaveBeenCalledWith({ phone: "90000 12345", firstName: "Asha" });
    done({ customer: customer() });
    await waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1));
  });

  it("a duplicate phone offers the existing customer instead of a second one", async () => {
    vi.mocked(api.createCustomer).mockRejectedValue(new ApiError(409, "CUSTOMER_EXISTS", "Priya Nair (+919000000000) already exists."));
    const h = setup();
    await type(screen.getByLabelText(/Mobile number/), "9000000000");
    await type(screen.getByLabelText(/First name/), "Priya");
    await userEvent.click(screen.getByRole("button", { name: "Create customer" }));
    expect(await screen.findByText("This customer already exists")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open existing customer" }));
    expect(h.onUseExisting).toHaveBeenCalledWith("9000000000");
  });

  it("after a lost answer it asks whether the customer exists instead of resending", async () => {
    vi.mocked(api.createCustomer).mockRejectedValue(new ApiError(502, "UPSTREAM_UNAVAILABLE", "Shopify did not confirm."));
    vi.mocked(api.customer).mockResolvedValue({ customer: customer() } as never);
    const h = setup();
    await type(screen.getByLabelText(/Mobile number/), "9000000000");
    await type(screen.getByLabelText(/First name/), "Priya");
    await userEvent.click(screen.getByRole("button", { name: "Create customer" }));
    await userEvent.click(await screen.findByRole("button", { name: "Check whether they exist" }));
    await waitFor(() => expect(h.onSaved).toHaveBeenCalled());
    expect(api.createCustomer).toHaveBeenCalledTimes(1);
  });
});

describe("CustomerForm (edit)", () => {
  it("shows the phone read-only and saves only name and email", async () => {
    vi.mocked(api.updateCustomer).mockResolvedValue({ customer: customer(), name: "Priya N", flags: { priority: false, family: false, campaigns: [] } });
    const onSaved = vi.fn();
    render(<CustomerForm mode="edit" customer={customer()} onSaved={onSaved} onCancel={vi.fn()} />);
    const phone = screen.getByLabelText(/Mobile number/) as HTMLInputElement;
    expect(phone.readOnly).toBe(true);
    expect(phone.value).toBe("+919000000000");
    const last = screen.getByLabelText("Last name");
    await userEvent.clear(last);
    await type(last, "N");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(api.updateCustomer).toHaveBeenCalledWith("80001000", { firstName: "Priya", lastName: "N", email: "priya@example.com" });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("puts the server's message for the email under the email field", async () => {
    vi.mocked(api.updateCustomer).mockRejectedValue(new ApiError(409, "CUSTOMER_EXISTS", "Another customer already has this email address.", { fields: { email: "Another customer already has this email address." } }));
    render(<CustomerForm mode="edit" customer={customer()} onSaved={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findAllByText("Another customer already has this email address.")).length).toBeGreaterThan(0);
  });
});

describe("PrescriptionForm", () => {
  const fill = async (label: string, value: string) => type(screen.getByLabelText(label), value);
  const setup = () => {
    const onSaved = vi.fn();
    render(<PrescriptionForm customerId="80001000" customerName="Priya Nair" onSaved={onSaved} onCancel={vi.fn()} />);
    return onSaved;
  };

  it("requires SPH, and an axis wherever there is a cylinder, naming the eye", async () => {
    setup();
    await fill("Left eye (OS) CYL", "-1.25");
    await userEvent.click(screen.getByRole("button", { name: "Save prescription" }));
    expect(screen.getAllByText("SPH is required (0 for plano).")).toHaveLength(2);
    expect(screen.getByText("AXIS is required when there is a cylinder.")).toBeTruthy();
    expect(screen.getByText("Please correct the highlighted fields")).toBeTruthy();
    expect(api.addPrescription).not.toHaveBeenCalled();
  });

  it("flags values off the 0.25 grid and an axis out of range", async () => {
    setup();
    await fill("Right eye (OD) SPH", "-2.1");
    await fill("Right eye (OD) CYL", "-1");
    await fill("Right eye (OD) AXIS", "200");
    await fill("Left eye (OS) SPH", "0");
    await userEvent.click(screen.getByRole("button", { name: "Save prescription" }));
    expect(screen.getByText("SPH must be a number in steps of 0.25.")).toBeTruthy();
    expect(screen.getByText("AXIS is a whole number from 0 to 180.")).toBeTruthy();
  });

  it("saves the numbers as numbers, with one clientRef however many times it is tapped or retried", async () => {
    vi.mocked(api.addPrescription).mockRejectedValueOnce(new ApiError(502, "UPSTREAM_UNAVAILABLE", "The store tool did not confirm the prescription."));
    vi.mocked(api.addPrescription).mockResolvedValueOnce(rx("RX5100"));
    const onSaved = setup();
    await fill("Right eye (OD) SPH", "-2.25");
    await fill("Right eye (OD) CYL", "-0.75");
    await fill("Right eye (OD) AXIS", "90");
    await fill("Left eye (OS) SPH", "+1.5");
    await fill("Left eye (OS) ADD", "2");
    const save = screen.getByRole("button", { name: "Save prescription" });
    await userEvent.click(save);
    expect(await screen.findByText("Could not confirm the prescription was saved")).toBeTruthy();
    await userEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const [, first] = vi.mocked(api.addPrescription).mock.calls[0]!;
    const [, second] = vi.mocked(api.addPrescription).mock.calls[1]!;
    expect(first.clientRef).toBeTruthy();
    expect(second.clientRef).toBe(first.clientRef); // the same save, so the server stores it once
    expect(first).toMatchObject({ od: { sph: -2.25, cyl: -0.75, axis: 90, add: null }, os: { sph: 1.5, cyl: 0, axis: null, add: 2 }, notes: null });
  });

  it("shows the server's per-field message on the field it is about", async () => {
    vi.mocked(api.addPrescription).mockRejectedValue(new ApiError(422, "RX_INVALID", "The prescription needs correcting: Left eye (OS): SPH must be between -20 and +20.", { fields: { "os.sph": "Left eye (OS): SPH must be between -20 and +20." } }));
    setup();
    await fill("Right eye (OD) SPH", "-1");
    await fill("Left eye (OS) SPH", "-19");
    await userEvent.click(screen.getByRole("button", { name: "Save prescription" }));
    const msgs = await screen.findAllByText("Left eye (OS): SPH must be between -20 and +20.");
    expect(msgs.some((m) => m.className.includes("field-error"))).toBe(true);
  });
});
