import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EvidencePanel,
  InvestigationModeControl,
  type EvidenceItemView,
} from "./EvidencePanel";

const evidence: EvidenceItemView = {
  id: "ev-1",
  title: "Checkout timeout cluster",
  eventRefs: [
    {
      corpusId: "c1",
      seq: 4,
      source: "api/app.jsonl",
      timestampHint: 1_700_000_004,
      timeQualityHint: "wall",
    },
    {
      corpusId: "c1",
      seq: 9,
      source: "worker/worker.log",
      timestampHint: 1_700_000_009,
      timeQualityHint: "wall",
    },
  ],
  evidenceStatus: "verified",
  createdAt: 1_700_000_100,
  provenanceLabel: "Saved manually",
};

function modeControl() {
  return (
    <InvestigationModeControl
      mode="evidence"
      evidenceCount={1}
      chatCount={2}
      onChange={() => undefined}
    />
  );
}

describe("EvidencePanel", () => {
  it("presents durable evidence with compact counts and explicit actions", () => {
    const preview = vi.fn();
    const reveal = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        onPreview={preview}
        onReveal={reveal}
        onClearPreview={() => undefined}
      />,
    );

    const card = screen.getByTestId("evidence-item-ev-1");
    expect(card.textContent).toContain("Checkout timeout cluster");
    expect(card.textContent).toContain("2 events · 2 sources");
    expect(card.textContent).toContain("Verified");
    fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
    fireEvent.click(within(card).getByRole("button", { name: "Reveal" }));
    expect(preview).toHaveBeenCalledWith(evidence);
    expect(reveal).toHaveBeenCalledWith(evidence);
  });

  it("previews authoritative rows without making reveal available for stale identities", () => {
    const stale = { ...evidence, evidenceStatus: "stale" as const };
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[stale]}
        preview={{
          evidenceId: stale.id,
          events: [
            {
              seq: 4,
              ts: 1_700_000_004,
              timeQuality: "wall",
              level: "error",
              service: "checkout",
              host: null,
              templateId: 7,
              traceId: "trace-4",
              message: "checkout timed out",
              source: "api/app.jsonl",
            },
          ],
          missingCount: 0,
          staleCount: 1,
        }}
        busy={false}
        error={null}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
      />,
    );

    const preview = screen.getByTestId("evidence-preview");
    expect(preview.textContent).toContain("current view unchanged");
    expect(preview.textContent).toContain("1 changed");
    expect(preview.textContent).toContain("checkout timed out");
    expect(
      (
        within(preview).getByRole("button", {
          name: "Reveal in Explorer",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps the shared rail mode selector explicit and screen-reader labeled", () => {
    const change = vi.fn();
    render(
      <InvestigationModeControl
        mode="evidence"
        evidenceCount={3}
        chatCount={2}
        onChange={change}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: /Evidence 3 saved evidence items/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: /Chat 2 linked chats/ }),
    );
    expect(change).toHaveBeenCalledWith("chat");
  });

  it("collapses to a compact Investigation rail and restores focus both ways", async () => {
    const toggle = vi.fn();
    const view = render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        collapsed={false}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
        onToggleCollapsed={toggle}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Investigation rail" }),
    );
    expect(toggle).toHaveBeenCalledTimes(1);
    view.rerender(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        collapsed
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
        onToggleCollapsed={toggle}
      />,
    );
    const reopen = screen.getByRole("button", {
      name: "Expand Investigation rail, 1 evidence item",
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(reopen));

    view.rerender(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        collapsed={false}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
        onToggleCollapsed={toggle}
      />,
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: "Collapse Investigation rail",
        }),
      ),
    );
  });
});
