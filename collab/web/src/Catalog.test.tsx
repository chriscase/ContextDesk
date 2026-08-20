import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "./Catalog.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("source catalog UI", () => {
  it("lists catalog kinds including unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          sources: [
            { id: "1", name: "Unknown", kind: "unknown", lifecycle: "active" },
            { id: "2", name: "Alice", kind: "human", lifecycle: "active" },
          ],
        }),
      })),
    );
    render(<Catalog canLead={true} />);
    expect(await screen.findByText(/Unknown/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "unknown" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add source" })).toBeTruthy();
  });

  it("resets the add-source form after a delayed POST", async () => {
    const sources = [
      { id: "1", name: "Unknown", kind: "unknown", lifecycle: "active" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/catalog/sources" && method === "POST") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          sources.push({
            id: "2",
            name: "Fixture chat assistant",
            kind: "external-tool",
            lifecycle: "active",
          });
          return { ok: true, json: async () => ({ id: "2" }) };
        }
        return { ok: true, json: async () => ({ sources: [...sources] }) };
      }),
    );
    render(<Catalog canLead={true} />);
    expect(await screen.findByText(/Unknown/)).toBeTruthy();
    const name = screen.getByPlaceholderText("Source name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Fixture chat assistant" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(await screen.findByText(/Fixture chat assistant/)).toBeTruthy();
    expect(name.value).toBe("");
  });
});
