import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cases } from "./Cases.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASES = [
  {
    id: "c1",
    title: "Fixture incident",
    problemStatement: "Synthetic requests pause while a fixture worker restarts.",
    affectedParties: "Northwind storefront operators",
    status: "open",
    severity: "high",
  },
  {
    id: "c2",
    title: "Retired mailer backlog",
    problemStatement: "Synthetic mailer backlog, concluded and filed away.",
    status: "archived",
    severity: "low",
  },
];

function stubFetch(cases: unknown[] = CASES) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/cases") return { ok: true, json: async () => ({ cases }) };
      if (url === "/api/catalog/sources") return { ok: true, json: async () => ({ sources: [] }) };
      if (url === "/api/investigation-activity?limit=30") {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

async function openInventory() {
  render(<Cases roles={["case-lead"]} view="investigations" />);
  return screen.findByRole("searchbox");
}

describe("the working list leaves archived investigations out", () => {
  it("hides an archived investigation and says how many it hid", async () => {
    stubFetch();
    await openInventory();
    expect(screen.getByRole("button", { name: "Fixture incident" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retired mailer backlog" })).toBeNull();
    expect(screen.getByText(/1 archived investigation is hidden/i)).toBeTruthy();
  });

  it("reveals them through the inline control in the notice", async () => {
    stubFetch();
    await openInventory();
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByRole("button", { name: "Retired mailer backlog" })).toBeTruthy();
    expect(screen.queryByText(/archived investigation is hidden/i)).toBeNull();
  });

  it("reveals them through the Include archived checkbox", async () => {
    stubFetch();
    await openInventory();
    fireEvent.click(screen.getByRole("checkbox", { name: /Include archived/i }));
    expect(screen.getByRole("button", { name: "Retired mailer backlog" })).toBeTruthy();
  });

  it("says nothing about archiving when there is nothing archived", async () => {
    stubFetch([CASES[0]]);
    await openInventory();
    expect(screen.queryByText(/archived investigation/i)).toBeNull();
  });

  it("keeps the archived count in the status filter so the option is not empty", async () => {
    stubFetch();
    await openInventory();
    const statusFilter = screen.getByRole("combobox", {
      name: "Filter investigations by status",
    }) as HTMLSelectElement;
    const archived = [...statusFilter.options].find((option) => option.value === "archived");
    expect(archived?.textContent).toMatch(/archived \(1\)/);
  });

  it("shows archived investigations when that status is chosen explicitly", async () => {
    stubFetch();
    await openInventory();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter investigations by status" }), {
      target: { value: "archived" },
    });
    expect(screen.getByRole("button", { name: "Retired mailer backlog" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fixture incident" })).toBeNull();
  });
});

describe("search reaches the situation text the card is remembered by", () => {
  it("finds an investigation by its affected parties", async () => {
    stubFetch();
    const search = await openInventory();
    fireEvent.change(search, { target: { value: "northwind" } });
    expect(screen.getByRole("button", { name: "Fixture incident" })).toBeTruthy();
  });

  it("finds an investigation by its problem statement", async () => {
    stubFetch();
    const search = await openInventory();
    fireEvent.change(search, { target: { value: "fixture worker restarts" } });
    expect(screen.getByRole("button", { name: "Fixture incident" })).toBeTruthy();
  });

  it("reports an honest empty result rather than a silent one", async () => {
    stubFetch();
    const search = await openInventory();
    fireEvent.change(search, { target: { value: "payment gateway" } });
    expect(screen.getByText(/No investigations match the current search or filter/i)).toBeTruthy();
  });
});
