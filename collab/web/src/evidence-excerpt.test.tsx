import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactExcerpt, readableTraceExcerpt } from "./evidence-excerpt.js";

/**
 * Engineers read log excerpts and stack traces constantly, so the rules for
 * showing one are the same everywhere: a bounded preview, the complete text one
 * disclosure away, and the real scale stated so a truncated view is never
 * mistaken for the whole record.
 */

afterEach(cleanup);

const STACK_TRACE = [
  "2026-08-24T09:12:03Z ERROR checkout.payment: inventory call timed out after 30000ms",
  "  at InventoryClient.reserve (inventory-client.ts:142)",
  "  at CheckoutSession.hold (checkout-session.ts:88)",
  "  at CheckoutSession.submit (checkout-session.ts:51)",
  "  at PaymentRoute.handle (payment-route.ts:37)",
  "  at Router.dispatch (router.ts:210)",
  "  at Server.onRequest (server.ts:96)",
  "2026-08-24T09:12:03Z WARN checkout.payment: returning basket to customer",
].join("\n");

describe("ArtifactExcerpt", () => {
  it("shows a short excerpt whole, with no disclosure to open", () => {
    render(<ArtifactExcerpt text="inventory call timed out" />);
    expect(screen.getByText("inventory call timed out")).toBeTruthy();
    expect(document.querySelector("details")).toBeNull();
  });

  it("bounds a large trace and states its real scale", () => {
    render(<ArtifactExcerpt text={STACK_TRACE} label="checkout-timeout.log" />);
    const disclosure = document.querySelector("details");
    expect(disclosure).toBeTruthy();
    expect(disclosure?.hasAttribute("open")).toBe(false);
    // The reader is told how much is behind the disclosure before opening it,
    // so a bounded preview is never mistaken for the whole record.
    const summary = disclosure?.querySelector("summary");
    expect(summary?.getAttribute("aria-label")).toContain("8 lines");
    expect(summary?.textContent).toContain("8 lines");
  });

  it("does not repeat the preview above the complete text once expanded", () => {
    const { container } = render(<ArtifactExcerpt text={STACK_TRACE} />);
    const collapsible = container.querySelector(".experiment-lab__artifact-collapsible");
    const preview = collapsible?.querySelector(".experiment-lab__artifact-preview");
    const disclosure = collapsible?.querySelector("details");
    expect(preview).toBeTruthy();
    expect(disclosure).toBeTruthy();
    // The stylesheet hides the preview while the disclosure is open, so the
    // opening lines are not printed twice above the full trace. Assert the
    // structural contract that rule selects on, since jsdom applies no CSS.
    expect(preview?.parentElement).toBe(collapsible);
    expect(disclosure?.parentElement).toBe(collapsible);
    expect(collapsible?.querySelectorAll(":scope > .experiment-lab__artifact-preview")).toHaveLength(
      1,
    );
    expect(collapsible?.querySelectorAll(":scope > details")).toHaveLength(1);
  });

  it("keeps the expanded text verbatim, including lines the preview dropped", () => {
    const { container } = render(<ArtifactExcerpt text={STACK_TRACE} />);
    const full = container.querySelector(".experiment-lab__artifact-full");
    expect(full?.textContent).toBe(STACK_TRACE);
    expect(full?.textContent).toContain("at Server.onRequest (server.ts:96)");
  });

  it("offers a copy control only where a caller asked for one", () => {
    const { unmount } = render(<ArtifactExcerpt text={STACK_TRACE} label="trace.log" copyable />);
    expect(screen.getByRole("button", { name: "Copy trace.log text" })).toBeTruthy();
    unmount();
    render(<ArtifactExcerpt text={STACK_TRACE} label="trace.log" />);
    expect(screen.queryByRole("button", { name: /^Copy/ })).toBeNull();
  });
});

describe("readableTraceExcerpt", () => {
  it("drops a bare evidence reference that carries no meaning for a reader", () => {
    expect(readableTraceExcerpt("inventory timed out; evidence ev-demo-checkout-log")).toBe(
      "inventory timed out",
    );
  });

  it("says so when a step held nothing but a reference", () => {
    expect(readableTraceExcerpt("evidence ev-demo-checkout-log")).toBe(
      "This step contains only a technical evidence reference.",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(readableTraceExcerpt("Raise the inventory client timeout.")).toBe(
      "Raise the inventory client timeout.",
    );
  });
});
