import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  LogImportConfidenceDto,
  LogTimezoneApplyRequestDto,
  LogTimezoneClearRequestDto,
  LogTimezonePreviewRequestDto,
  LogTimezoneResolutionPreviewDto,
} from "../../lib/host";
import { LogImportConfidence } from "./LogImportConfidence";

const TIMEZONE_SCOPE = {
  corpusId: "corpus-779",
  eventRevision: 6,
} as const;

function unresolvedReport(source = "edge/server.log"): LogImportConfidenceDto {
  return {
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
        source,
        lines: 24,
        formatId: "local-minute-zone-level-record",
        formatVersion: 1,
        outcome: "matched",
        runnerUpMargin: 100,
        producerHint: null,
        timeQuality: "order_only",
        unresolvedReasons: ["zone_abbreviation_not_resolved"],
        timestampPrefixSamples: ["2021-03-05T00:06,350 CET"],
      },
    ],
  };
}

function preview(
  source: string,
  ianaZone: string,
): LogTimezoneResolutionPreviewDto {
  return {
    corpusId: TIMEZONE_SCOPE.corpusId,
    eventRevision: TIMEZONE_SCOPE.eventRevision,
    source,
    ianaZone,
    previewToken: `preview:${source}:${ianaZone}`,
    affectedRecords: 21,
    existingWallClockRecords: 4,
    firstResolvedTs: Date.parse("2021-03-05T00:00:05Z") / 1000,
    lastResolvedTs: Date.parse("2021-03-05T01:00:05Z") / 1000,
    dstGapRecords: 1,
    dstFoldAmbiguities: 2,
    unchangedOrderOnlyRecords: 3,
    unsupportedTimestampRecords: 1,
    zoneAbbreviationMismatchRecords: 2,
    outOfRangeRecords: 0,
    precision: "whole_second",
  };
}

async function openReview(
  options: {
    suggestion?: string;
    declaration?: {
      source: string;
      ianaZone: string;
      basis: "user_declared";
      declaredAt: number;
      appliedRevision: number;
    };
    onPreview?: (
      request: LogTimezonePreviewRequestDto,
    ) => Promise<LogTimezoneResolutionPreviewDto>;
    onApply?: (request: LogTimezoneApplyRequestDto) => Promise<void>;
    onClear?: (request: LogTimezoneClearRequestDto) => Promise<void>;
  } = {},
) {
  const onPreview =
    options.onPreview ??
    vi.fn(async ({ source, ianaZone }) => preview(source, ianaZone));
  const onApply = options.onApply ?? vi.fn(async () => undefined);
  const onClear = options.onClear ?? vi.fn(async () => undefined);
  render(
    <LogImportConfidence
      confidence={unresolvedReport()}
      timezoneScope={TIMEZONE_SCOPE}
      timezoneSuggestions={
        options.suggestion
          ? { "edge/server.log": options.suggestion }
          : undefined
      }
      timezoneDeclarations={
        options.declaration
          ? { "edge/server.log": options.declaration }
          : undefined
      }
      onPreviewTimezone={onPreview}
      onApplyTimezone={onApply}
      onClearTimezone={onClear}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Review 1 source" }));
  const trigger = screen.getByRole("button", {
    name: options.declaration ? "Review timezone…" : "Resolve time…",
  });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", {
    name: "Review timezone",
  });
  return { dialog, trigger, onPreview, onApply, onClear };
}

describe("LogTimezoneReviewDialog", () => {
  it("prefills the computer timezone without silently activating it", async () => {
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({
        locale: "en-US",
        calendar: "gregory",
        numberingSystem: "latn",
        timeZone: "America/Chicago",
      });

    const { dialog, onPreview, onApply } = await openReview();
    const leaveUnresolved = within(dialog).getByRole("radio", {
      name: /Leave unresolved — order-only/,
    }) as HTMLInputElement;
    const zone = within(dialog).getByRole("combobox", {
      name: /^IANA timezone/,
    }) as HTMLInputElement;

    expect(leaveUnresolved.checked).toBe(true);
    expect(zone.value).toBe("America/Chicago");
    expect(zone.disabled).toBe(true);
    const timezoneList = document.getElementById(
      zone.getAttribute("list") ?? "",
    );
    expect(timezoneList).not.toBeNull();
    expect(
      Array.from(timezoneList?.querySelectorAll("option") ?? []).map(
        (option) => option.getAttribute("value"),
      ),
    ).toEqual(expect.arrayContaining(["America/Chicago", "UTC"]));
    expect(
      timezoneList
        ?.querySelector('option[value="America/Chicago"]')
        ?.getAttribute("label"),
    ).toMatch(/Chicago.*UTC/);
    expect(dialog.textContent).toContain(
      "Browse or type to filter by location",
    );
    expect(dialog.textContent).toContain(
      "historical daylight-saving rules to each log time",
    );
    expect(dialog.textContent).toContain(
      "This computer’s timezone filled this field as a convenience; it is not active",
    );
    expect(onPreview).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    resolvedOptions.mockRestore();
  });

  it("defaults a hinted unresolved source to order-only and explains uncertainty", async () => {
    const { dialog, trigger, onPreview, onApply } = await openReview({
      suggestion: "Europe/Berlin",
    });

    const leaveUnresolved = within(dialog).getByRole("radio", {
      name: /Leave unresolved — order-only/,
    }) as HTMLInputElement;
    const useZone = within(dialog).getByRole("radio", {
      name: /Use an IANA timezone/,
    }) as HTMLInputElement;
    const zone = within(dialog).getByRole("combobox", {
      name: /^IANA timezone/,
    }) as HTMLInputElement;
    const previewButton = within(dialog).getByRole("button", {
      name: "Preview",
    }) as HTMLButtonElement;
    const applyButton = within(dialog).getByRole("button", {
      name: "Apply declaration",
    }) as HTMLButtonElement;

    expect(leaveUnresolved.checked).toBe(true);
    expect(useZone.checked).toBe(false);
    expect(zone.value).toBe("Europe/Berlin");
    expect(zone.disabled).toBe(true);
    expect(previewButton.disabled).toBe(true);
    expect(applyButton.disabled).toBe(true);
    expect(dialog.textContent).toContain(
      "A saved or bundle hint filled this field; it is not active",
    );
    expect(dialog.textContent).toContain(
      "Abbreviations such as CET can refer to different regional or historic rules",
    );

    fireEvent.click(
      within(dialog).getByText(
        "Why timezone review can leave records unresolved",
      ),
    );
    expect(dialog.textContent).toContain(
      "Some local times never occurred when clocks moved forward",
    );
    expect(dialog.textContent).toContain(
      "Some local times occurred twice when clocks moved backward",
    );
    expect(onPreview).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    await waitFor(() => expect(document.activeElement).toBe(leaveUnresolved));
    fireEvent.keyDown(leaveUnresolved, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review timezone" }),
      ).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("can dismiss an in-flight preview without accepting its late result", async () => {
    let finishPreview:
      ((value: LogTimezoneResolutionPreviewDto) => void) | undefined;
    const onPreview = vi.fn(
      () =>
        new Promise<LogTimezoneResolutionPreviewDto>((resolve) => {
          finishPreview = resolve;
        }),
    );
    const { dialog, trigger } = await openReview({ onPreview });
    fireEvent.click(
      within(dialog).getByRole("radio", {
        name: /Use an IANA timezone/,
      }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: /^IANA timezone/ }),
      { target: { value: "Europe/Berlin" } },
    );
    const previewButton = within(dialog).getByRole("button", {
      name: "Preview",
    });
    fireEvent.click(previewButton);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Close timezone review",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.keyDown(previewButton, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Review timezone" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);

    finishPreview?.(preview("edge/server.log", "Europe/Berlin"));
    await Promise.resolve();
    expect(
      screen.queryByRole("region", { name: "Timezone preview" }),
    ).toBeNull();
  });

  it("dismisses from the backdrop and restores focus", async () => {
    const { trigger } = await openReview();
    fireEvent.mouseDown(screen.getByTestId("timezone-review-backdrop"));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Review timezone" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("binds Apply to the current successful preview and invalidates it on zone change", async () => {
    const onPreview = vi.fn(async ({ source, ianaZone }) =>
      preview(source, ianaZone),
    );
    const { dialog, trigger, onApply } = await openReview({ onPreview });
    const useZone = within(dialog).getByRole("radio", {
      name: /Use an IANA timezone/,
    });
    const zone = within(dialog).getByRole("combobox", {
      name: /^IANA timezone/,
    }) as HTMLInputElement;

    fireEvent.click(useZone);
    fireEvent.change(zone, { target: { value: "Europe/Berlin" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));

    const result = await within(dialog).findByRole("region", {
      name: "Timezone preview",
    });
    expect(onPreview).toHaveBeenCalledWith({
      corpusId: "corpus-779",
      eventRevision: 6,
      source: "edge/server.log",
      ianaZone: "Europe/Berlin",
    });
    expect(result.textContent).toContain("21 records");
    expect(result.textContent).toContain("2021-03-05 00:00:05Z");
    expect(result.textContent).toContain("2021-03-05 01:00:05Z");
    expect(result.textContent).toContain("21 records resolved");
    expect(result.textContent).toContain("9 records remain order-only");
    expect(result.textContent).toContain("Resulting source quality: mixed");
    expect(
      within(result).getByText("Already exact").nextElementSibling?.textContent,
    ).toBe("4 records");
    expect(
      within(result).getByText("DST gaps").nextElementSibling?.textContent,
    ).toBe("1 record");
    expect(
      within(result).getByText("DST fold ambiguity").nextElementSibling
        ?.textContent,
    ).toBe("2 records");
    expect(
      within(result).getByText("Unchanged / order-only").nextElementSibling
        ?.textContent,
    ).toBe("3 records");
    expect(
      within(result).getByText("Zone abbreviation conflict")
        .nextElementSibling?.textContent,
    ).toBe("2 records");
    expect(result.textContent).toContain("coarse whole-second precision");

    const apply = within(dialog).getByRole("button", {
      name: "Apply declaration",
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);

    fireEvent.change(zone, { target: { value: "America/Chicago" } });
    expect(
      within(dialog).queryByRole("region", { name: "Timezone preview" }),
    ).toBeNull();
    expect(apply.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    await within(dialog).findByText("Preview for America/Chicago");
    fireEvent.click(apply);

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        corpusId: "corpus-779",
        expectedRevision: 6,
        source: "edge/server.log",
        ianaZone: "America/Chicago",
        previewToken: "preview:edge/server.log:America/Chicago",
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review timezone" }),
      ).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("accepts canonical UTC but rejects ambiguous abbreviations", async () => {
    const { dialog, onPreview } = await openReview();
    fireEvent.click(
      within(dialog).getByRole("radio", {
        name: /Use an IANA timezone/,
      }),
    );
    const zone = within(dialog).getByRole("combobox", {
      name: /^IANA timezone/,
    }) as HTMLInputElement;
    const previewButton = within(dialog).getByRole("button", {
      name: "Preview",
    }) as HTMLButtonElement;

    fireEvent.change(zone, { target: { value: "CET" } });
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    expect(previewButton.disabled).toBe(true);

    fireEvent.change(zone, { target: { value: "UTC" } });
    expect(zone.getAttribute("aria-invalid")).toBe("false");
    expect(previewButton.disabled).toBe(false);
    fireEvent.click(previewButton);
    await waitFor(() =>
      expect(onPreview).toHaveBeenCalledWith({
        corpusId: "corpus-779",
        eventRevision: 6,
        source: "edge/server.log",
        ianaZone: "UTC",
      }),
    );
  });

  it("rejects a stale or mismatched preview instead of enabling Apply", async () => {
    const onPreview = vi.fn(async () => ({
      ...preview("edge/server.log", "Europe/Berlin"),
      eventRevision: 7,
    }));
    const { dialog } = await openReview({ onPreview });
    fireEvent.click(
      within(dialog).getByRole("radio", {
        name: /Use an IANA timezone/,
      }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: /^IANA timezone/ }),
      { target: { value: "Europe/Berlin" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "preview no longer matches this source, timezone, or corpus revision",
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Apply declaration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows an honest zero-change preview without enabling Apply", async () => {
    const onPreview = vi.fn(async ({ source, ianaZone }) => ({
      ...preview(source, ianaZone),
      affectedRecords: 0,
      unchangedOrderOnlyRecords: 24,
    }));
    const { dialog } = await openReview({ onPreview });
    fireEvent.click(
      within(dialog).getByRole("radio", {
        name: /Use an IANA timezone/,
      }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: /^IANA timezone/ }),
      { target: { value: "Europe/Berlin" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));

    expect(
      await within(dialog).findByText(
        /No records can be resolved by this declaration/,
      ),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("Resulting source quality: mixed");
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Apply declaration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("discards a preview when the reviewed source changes", async () => {
    const onPreview = vi.fn(async ({ source, ianaZone }) =>
      preview(source, ianaZone),
    );
    const onApply = vi.fn(async () => undefined);
    const { rerender } = render(
      <LogImportConfidence
        confidence={unresolvedReport("first/server.log")}
        timezoneScope={TIMEZONE_SCOPE}
        onPreviewTimezone={onPreview}
        onApplyTimezone={onApply}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review 1 source" }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve time…" }));
    let dialog = await screen.findByRole("dialog", {
      name: "Review timezone",
    });
    fireEvent.click(
      within(dialog).getByRole("radio", {
        name: /Use an IANA timezone/,
      }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: /^IANA timezone/ }),
      { target: { value: "Europe/Berlin" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    await within(dialog).findByRole("region", { name: "Timezone preview" });

    rerender(
      <LogImportConfidence
        confidence={unresolvedReport("second/server.log")}
        timezoneScope={TIMEZONE_SCOPE}
        onPreviewTimezone={onPreview}
        onApplyTimezone={onApply}
      />,
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review timezone" }),
      ).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Resolve time…" }));
    dialog = await screen.findByRole("dialog", { name: "Review timezone" });
    expect(dialog.textContent).toContain("second/server.log");
    expect(
      within(dialog).queryByRole("region", { name: "Timezone preview" }),
    ).toBeNull();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Apply declaration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation to remove a declaration and keeps raw time reversible", async () => {
    const declaration = {
      source: "edge/server.log",
      ianaZone: "Europe/Berlin",
      basis: "user_declared" as const,
      declaredAt: 1_725_000_000,
      appliedRevision: 7,
    };
    const { dialog, trigger, onClear } = await openReview({ declaration });
    expect(dialog.textContent).toContain(
      "Europe/Berlin is the active source timezone",
    );
    expect(dialog.textContent).not.toContain(
      "cannot be placed on a shared wall clock until you declare",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove declaration…" }),
    );
    expect(onClear).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain(
      "Raw timestamp text stays unchanged, and you can declare a zone again later",
    );

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Remove and use order-only",
      }),
    );
    await waitFor(() =>
      expect(onClear).toHaveBeenCalledWith({
        corpusId: "corpus-779",
        expectedRevision: 6,
        source: "edge/server.log",
        appliedRevision: 7,
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review timezone" }),
      ).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("traps keyboard focus inside the dialog", async () => {
    const { dialog } = await openReview();
    const close = within(dialog).getByRole("button", {
      name: "Close timezone review",
    });
    const useZone = within(dialog).getByRole("radio", {
      name: /Use an IANA timezone/,
    });
    const explanation = within(dialog).getByText(
      "Why timezone review can leave records unresolved",
    );

    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(explanation);

    explanation.focus();
    fireEvent.keyDown(explanation, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    useZone.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
