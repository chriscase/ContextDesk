import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LogImportConfidenceDto } from "../../lib/host";
import { LogImportConfidence } from "./LogImportConfidence";

function report(
  overrides: Partial<LogImportConfidenceDto> = {},
): LogImportConfidenceDto {
  return {
    corpusTimeQuality: "wall",
    counts: {
      wall: 1,
      orderOnly: 0,
      mixed: 0,
      matched: 1,
      ambiguous: 0,
      unknown: 0,
      unresolved: 0,
    },
    sources: [
      {
        source: "api/events.jsonl",
        lines: 10,
        formatId: "json",
        formatVersion: 1,
        outcome: "matched",
        runnerUpMargin: 100,
        producerHint: null,
        timeQuality: "wall",
        unresolvedReasons: [],
        timestampPrefixSamples: [],
      },
    ],
    ...overrides,
  };
}

describe("LogImportConfidence", () => {
  it("reports an all-exact import without inventing review work", () => {
    render(<LogImportConfidence confidence={report()} />);

    const region = screen.getByTestId("log-import-confidence");
    expect(region.textContent).toContain(
      "1 exact wall-clock source · all source formats matched",
    );
    expect(region.textContent).toContain(
      "Every imported source has an exact wall clock and a matched grammar",
    );
    expect(within(region).getByRole("status").textContent).toContain(
      "1 exact wall-clock source; 0 sources need review",
    );
    expect(within(region).queryByRole("button", { name: /Review/ })).toBeNull();
  });

  it("distinguishes an unresolved abbreviation from grammar ambiguity", () => {
    render(
      <LogImportConfidence
        confidence={report({
          corpusTimeQuality: "order_only",
          counts: {
            wall: 0,
            orderOnly: 1,
            mixed: 0,
            matched: 0,
            ambiguous: 1,
            unknown: 0,
            unresolved: 1,
          },
          sources: [
            {
              source: "edge/server.log",
              lines: 24,
              formatId: "local-minute-zone-level-record",
              formatVersion: 1,
              outcome: "ambiguous",
              runnerUpMargin: 0,
              producerHint: null,
              timeQuality: "order_only",
              unresolvedReasons: ["zone_abbreviation_not_resolved"],
              timestampPrefixSamples: ["2021-03-05T00:06,350 CET"],
            },
          ],
        })}
      />,
    );

    const region = screen.getByTestId("log-import-confidence");
    fireEvent.click(
      within(region).getByRole("button", { name: "Review 1 source" }),
    );
    expect(region.textContent).toContain(
      "Zone abbreviation not resolved — order-only",
    );
    expect(region.textContent).toContain("Multiple grammars fit — margin 0");
    expect(
      within(region).getByLabelText("Timestamp examples for edge/server.log")
        .textContent,
    ).toBe("2021-03-05T00:06,350 CET");
    expect(
      within(region).queryByRole("button", { name: "Resolve time…" }),
    ).toBeNull();
  });

  it("labels unknown formats without claiming parsing failed", () => {
    render(
      <LogImportConfidence
        confidence={report({
          corpusTimeQuality: "wall",
          counts: {
            wall: 1,
            orderOnly: 0,
            mixed: 0,
            matched: 0,
            ambiguous: 0,
            unknown: 1,
            unresolved: 0,
          },
          sources: [
            {
              source: "legacy/output.txt",
              lines: 3,
              outcome: "unknown",
              timeQuality: "wall",
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review 1 source" }));
    expect(screen.getByText(/Every source has an exact wall clock/)).toBeTruthy();
    expect(
      screen.getByText("No grammar matched — kept as raw lines"),
    ).toBeTruthy();
    expect(screen.getByText("Exact wall clock")).toBeTruthy();
  });

  it("does not mistake a prototype-shaped source name for a saved declaration", () => {
    const confidence = report({
      corpusTimeQuality: "order_only",
      counts: {
        wall: 0,
        orderOnly: 1,
        mixed: 0,
        matched: 1,
        ambiguous: 0,
        unknown: 0,
        unresolved: 1,
      },
      sources: [
        {
          source: "constructor",
          lines: 4,
          outcome: "matched",
          timeQuality: "order_only",
          unresolvedReasons: ["no_timezone"],
        },
      ],
    });
    render(
      <LogImportConfidence
        confidence={confidence}
        timezoneScope={{ corpusId: "prototype-source", eventRevision: 2 }}
        timezoneDeclarations={{}}
        onPreviewTimezone={vi.fn()}
        onApplyTimezone={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review 1 source" }));
    expect(
      screen.getByRole("button", { name: "Resolve time…" }),
    ).toBeTruthy();
    expect(screen.queryByText(/is active/)).toBeNull();
  });
});
