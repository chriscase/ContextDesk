import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("UI shell", () => {
  it("renders the rename-friendly working name", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "cd-collab" })).toBeTruthy();
  });
});
