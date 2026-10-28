// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Permission } from "./api/types";
import { authMock, fake, sessionMock } from "./test-utils";

vi.mock("./state/auth", () => authMock());
vi.mock("./state/session", () => ({ ...sessionMock(), SessionProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./pages/TillPage", () => ({ default: () => <div>till</div> }));
vi.mock("./pages/CustomersPage", () => ({ default: () => <div>customers page</div> }));
import App from "./App";

const SALES: Permission[] = ["customer:view", "customer:create", "customer:update", "prescription:create", "billing:use", "refund:create"];
const nav = () => screen.getAllByRole("link").map((a) => a.textContent);
beforeEach(() => { fake.store = "HSR"; });

describe("navigation by role", () => {
  it("a salesperson sees Customers but not Day-end", () => {
    fake.perms = SALES;
    render(<MemoryRouter initialEntries={["/customers"]}><App /></MemoryRouter>);
    expect(nav()).toEqual(expect.arrayContaining(["New sale", "Customers", "Refunds"]));
    expect(nav()).not.toContain("Day-end");
    expect(screen.getByText("customers page")).toBeTruthy();
  });

  it("a store manager also sees Day-end", () => {
    fake.perms = [...SALES, "discount:manager", "report:view", "report:download"];
    render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
    expect(nav()).toEqual(expect.arrayContaining(["Customers", "Day-end"]));
  });

  it("without the customer permission there is no Customers entry and the route is not found", () => {
    fake.perms = ["billing:use"];
    render(<MemoryRouter initialEntries={["/customers"]}><App /></MemoryRouter>);
    expect(nav()).not.toContain("Customers");
    expect(screen.getByText("Page not found")).toBeTruthy();
  });
});
