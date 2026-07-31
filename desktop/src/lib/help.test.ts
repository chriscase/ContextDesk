import { describe, expect, it } from "vitest";
import {
  helpOpenRequest,
  helpPageForSettingsSection,
  parseHelpLocator,
  requestHelpAcrossWindows,
  subscribeHelpAcrossWindows,
} from "./help";

describe("canonical Help deep links (#439)", () => {
  it("accepts stable page and anchor ids only", () => {
    expect(parseHelpLocator("help://memory-overview")).toEqual({
      pageId: "memory-overview",
      anchor: undefined,
    });
    expect(parseHelpLocator("help://log-analysis-pipeline#pipeline")).toEqual({
      pageId: "log-analysis-pipeline",
      anchor: "pipeline",
    });
    // #824 — phase-timings HelpTip locator (must match a real corpus H2 anchor).
    expect(
      parseHelpLocator("help://log-analysis-pipeline#import-phases"),
    ).toEqual({
      pageId: "log-analysis-pipeline",
      anchor: "import-phases",
    });
    for (const unsafe of [
      "help://../secret",
      "help://page?query=x",
      "help://page/%2e%2e",
      "https://example.com/help",
      "/tmp/help.md",
    ]) {
      expect(parseHelpLocator(unsafe)).toBeNull();
    }
  });

  it("creates a one-shot pane request without interpreting a URL", () => {
    expect(
      helpOpenRequest(4, {
        pageId: "permission-tiers",
        anchor: "tier-matrix",
      }),
    ).toEqual({
      requestId: 4,
      pageId: "permission-tiers",
      anchor: "tier-matrix",
      query: undefined,
      focusSearch: undefined,
    });
  });

  it("routes Settings families to real contextual pages", () => {
    expect(helpPageForSettingsSection("ai")).toBe("provider-setup");
    expect(helpPageForSettingsSection("workspace")).toBe("workspace-indexing");
    expect(helpPageForSettingsSection("backup")).toBe("s3-backup");
    expect(helpPageForSettingsSection("connectors")).toBe(
      "connectors-and-confluence",
    );
    expect(helpPageForSettingsSection("skills")).toBe("skills-context-packs");
    expect(helpPageForSettingsSection("appearance")).toBe("product-overview");
  });

  it("hands canonical Help requests across windows and rejects malformed storage data", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeHelpAcrossWindows((location) =>
      received.push(location),
    );
    requestHelpAcrossWindows({
      pageId: "log-explorer",
      anchor: "timeline-navigator",
    });
    expect(received).toEqual([
      { pageId: "log-explorer", anchor: "timeline-navigator" },
    ]);

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "contextdesk.help.open.v1",
        newValue: JSON.stringify({ pageId: "../private" }),
      }),
    );
    expect(received).toHaveLength(1);
    unsubscribe();
  });
});
