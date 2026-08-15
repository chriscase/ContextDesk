import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UI shell", () => {
  it("renders the rename-friendly working name and login form when signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }),
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: "cd-collab" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});
