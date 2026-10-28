// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import { authMock, fake, renderAt, row, customer } from "../test-utils";

vi.mock("../api/endpoints", () => ({ api: { customers: vi.fn() } }));
vi.mock("../state/auth", () => authMock());
import { api } from "../api/endpoints";
import CustomersPage from "./CustomersPage";

const customers = vi.mocked(api.customers);
const page = (items = [row()], nextCursor: string | null = null) => ({ items, nextCursor });
const show = () => renderAt("/customers", "/customers", <CustomersPage />);

beforeEach(() => {
  customers.mockReset();
  fake.perms = ["customer:view", "customer:create", "customer:update", "prescription:create", "billing:use"];
});

describe("CustomersPage", () => {
  it("shows a loading state, then the customers with phone, email, latest prescription and count", async () => {
    customers.mockResolvedValue(page([row(), row({ customer: customer({ id: "2", firstName: "Karthik", lastName: "R", email: null }), prescriptions: { count: 0, latest: null } })]));
    show();
    expect(screen.getByText(/Loading customers/)).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Customers" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("+919000000000")).toBeTruthy();
    expect(within(rows[1]!).getByText("priya@example.com")).toBeTruthy();
    expect(within(rows[1]!).getByText(/Valid until 2027-09-01/)).toBeTruthy();
    expect(within(rows[2]!).getByText("None on file")).toBeTruthy();
    expect(customers).toHaveBeenCalledWith({ q: "", cursor: null, limit: 20 });
  });

  it("searches on the server after a pause in typing, not by filtering what it already has", async () => {
    customers.mockResolvedValue(page());
    show();
    await screen.findByRole("table");
    customers.mockResolvedValue(page([row({ customer: customer({ id: "9", firstName: "Zed" }) })]));
    await userEvent.type(screen.getByRole("searchbox", { name: /search customers/i }), "zed");
    await waitFor(() => expect(customers).toHaveBeenLastCalledWith({ q: "zed", cursor: null, limit: 20 }));
    expect(await screen.findByText("Zed Nair")).toBeTruthy();
    expect(customers.mock.calls.filter(([a]) => a?.q === "z")).toHaveLength(0); // one request for the word, not one per letter
  });

  it("an older search answer never overwrites a newer one", async () => {
    let slow!: (v: ReturnType<typeof page>) => void;
    customers.mockImplementationOnce(() => new Promise((r) => { slow = r; }));
    show();
    await waitFor(() => expect(customers).toHaveBeenCalledTimes(1));
    customers.mockResolvedValue(page([row({ customer: customer({ id: "9", firstName: "Newer" }) })]));
    await userEvent.type(screen.getByRole("searchbox"), "n");
    expect(await screen.findByText("Newer Nair")).toBeTruthy();
    slow(page([row({ customer: customer({ id: "1", firstName: "Older" }) })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Older Nair")).toBeNull();
  });

  it("loads the next page on demand and appends it", async () => {
    customers.mockResolvedValueOnce(page([row()], "80001000"));
    show();
    await screen.findByRole("table");
    customers.mockResolvedValueOnce(page([row({ customer: customer({ id: "80001001", firstName: "Second" }) })], null));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second Nair")).toBeTruthy();
    expect(customers).toHaveBeenLastCalledWith({ q: "", cursor: "80001000", limit: 20 });
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("explains an empty search and an empty database differently", async () => {
    customers.mockResolvedValue(page([]));
    show();
    expect(await screen.findByText("No customers yet")).toBeTruthy();
    await userEvent.type(screen.getByRole("searchbox"), "nobody");
    expect(await screen.findByText("No customers match")).toBeTruthy();
  });

  it("shows the server's message with a retry, and recovers", async () => {
    customers.mockRejectedValueOnce(new ApiError(502, "UPSTREAM_UNAVAILABLE", "An upstream system is not responding. Try again."));
    show();
    expect(await screen.findByText(/not responding/)).toBeTruthy();
    customers.mockResolvedValue(page());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("shows 'Unavailable' for the prescription summary when the store tool did not answer, but still lists the customer", async () => {
    customers.mockResolvedValue(page([row({ prescriptions: null })]));
    show();
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("Priya Nair")).toBeTruthy();
  });

  it("has view, edit and start-sale links for each customer, and an Add customer button", async () => {
    customers.mockResolvedValue(page());
    show();
    await screen.findByRole("table");
    expect(screen.getByRole("link", { name: "View Priya Nair" }).getAttribute("href")).toBe("/customers/80001000");
    expect(screen.getByRole("link", { name: "Edit Priya Nair" }).getAttribute("href")).toBe("/customers/80001000/edit");
    expect(screen.getByRole("link", { name: "Start sale for Priya Nair" }).getAttribute("href")).toBe("/customers/80001000/sale");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    expect(screen.getByTestId("location").textContent).toBe("/customers/new");
  });

  it("hides what the role cannot do", async () => {
    fake.perms = ["customer:view"];
    customers.mockResolvedValue(page());
    show();
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Add customer" })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Start sale/ })).toBeNull();
  });
});
