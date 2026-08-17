import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "./Catalog.js";

afterEach(() => {
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
});
