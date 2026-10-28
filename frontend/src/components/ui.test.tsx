// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ConfirmDialog, Field, Pill, ToastProvider, useToast } from "./ui";

describe("Field", () => {
  it("ties the error to the control so it is read with it, and marks nothing by colour alone", () => {
    render(<Field label="Email" error="That does not look like an email address."><input aria-invalid /></Field>);
    const input = screen.getByLabelText(/Email/);
    const msg = screen.getByRole("alert");
    expect(input.getAttribute("aria-describedby")).toBe(msg.id);
    expect(msg.textContent).toMatch(/does not look like/);
  });
  it("shows the hint when there is no error", () => {
    render(<Field label="PD" hint="Optional"><input /></Field>);
    expect(screen.getByText("Optional")).toBeTruthy();
  });
});

describe("Pill", () => {
  it("carries an icon as well as words", () => {
    const { container } = render(<Pill tone="error">Expired 2026-01-01</Pill>);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toContain("Expired");
  });
});

describe("ConfirmDialog", () => {
  it("asks first: nothing happens until confirmed, and Cancel does nothing", async () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    render(<ConfirmDialog open title="Abandon this sale?" confirmLabel="Abandon sale" tone="danger" onConfirm={onConfirm} onCancel={onCancel}>It stays on the server.</ConfirmDialog>);
    expect(screen.getByText("Abandon this sale?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled(); expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Abandon sale" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("toasts", () => {
  it("announce a short confirmation politely", async () => {
    function Go() { const t = useToast(); return <button onClick={() => t.push("success", "Saved")}>go</button>; }
    render(<MemoryRouter><ToastProvider><Go /></ToastProvider></MemoryRouter>);
    await userEvent.click(screen.getByText("go"));
    expect(screen.getByText("Saved").closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
  });
});
