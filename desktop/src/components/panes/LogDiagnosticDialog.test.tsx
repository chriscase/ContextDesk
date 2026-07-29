import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogCorpusSummaryDto } from "../../lib/host";
import type { LogDiagnosticManifest } from "../../lib/logDiagnosticReport";
import {
  LogDiagnosticDialog,
  PREPARE_DEBOUNCE_MS,
} from "./LogDiagnosticDialog";

const hostMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../../lib/host", async () => {
  const actual = await vi.importActual<typeof import("../../lib/host")>(
    "../../lib/host",
  );
  return {
    ...actual,
    hostPrepareLogDiagnosticReport: hostMocks.prepare,
    hostReleaseLogDiagnosticReport: hostMocks.release,
    hostSaveLogDiagnosticReport: hostMocks.save,
  };
});

const corpus: LogCorpusSummaryDto = {
  id: "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c",
  name: "incident",
  eventCount: 12,
  templateCount: 3,
  engine: "duckdb",
  createdAt: 1_700_000_000,
  sourceLabel: "incident",
  stats: null,
  topTemplates: [],
  embedding: {
    state: "keyword_only",
    modelId: null,
    embeddedTemplates: 0,
    totalTemplates: 3,
    reason: "local_model_unavailable",
    updatedAt: 1,
  },
};

describe("LogDiagnosticDialog short-height layout", () => {
  beforeEach(() => {
    hostMocks.prepare.mockReset();
    hostMocks.release.mockReset();
    hostMocks.save.mockReset();
    hostMocks.prepare.mockResolvedValue({
      reportId: "cdlogdiag-0000000000000001-0000000000000001",
      markdown: Array.from(
        { length: 80 },
        (_, index) => `- diagnostic line ${index + 1}`,
      ).join("\n"),
      json: JSON.stringify({ schemaVersion: 1 }, null, 2),
    });
    hostMocks.release.mockResolvedValue(true);
    hostMocks.save.mockResolvedValue({ status: "saved" });
  });

  it("uses one keyboard-scrollable body while header and primary actions stay outside it", async () => {
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 420,
    });

    try {
      const { unmount } = render(
        <LogDiagnosticDialog
          corpus={corpus}
          environment={{
            appVersion: "0.1.0",
            channel: "dev",
            gitSha: "de43caeba66df05068a50db9356efad3b64a4a45",
            os: "macOS",
          }}
          currentStatus={null}
          onDismiss={vi.fn()}
        />,
      );

      const dialog = await screen.findByRole("dialog", {
        name: "Export corpus diagnostics",
      });
      const body = within(dialog).getByRole("region", {
        name: "Diagnostic details and exact preview",
      });
      const close = within(dialog).getByRole("button", {
        name: "Close diagnostic export",
      });
      const primary = within(dialog).getByRole("button", {
        name: "Save Markdown…",
      });

      await waitFor(() => expect(primary.hasAttribute("disabled")).toBe(false));
      expect(body.tabIndex).toBe(0);
      expect(body.contains(close)).toBe(false);
      expect(body.contains(primary)).toBe(false);
      expect(close.closest("header")?.parentElement).toBe(dialog);
      expect(primary.closest("footer")?.parentElement).toBe(dialog);
      Object.defineProperties(body, {
        clientHeight: { configurable: true, value: 180 },
        scrollHeight: { configurable: true, value: 960 },
      });
      body.scrollTop = 480;
      fireEvent.scroll(body);
      body.focus();
      expect(document.activeElement).toBe(body);
      expect(body.scrollTop).toBe(480);
      expect(primary.isConnected).toBe(true);

      close.focus();
      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(primary);
      unmount();
      await waitFor(() =>
        expect(hostMocks.release).toHaveBeenCalledWith(
          "cdlogdiag-0000000000000001-0000000000000001",
        ),
      );
    } finally {
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
    }
  });

  it("serializes more than eight delayed note generations and saves only the latest preview", async () => {
    vi.useFakeTimers();
    let resolveFirst:
      | ((value: {
          reportId: string;
          markdown: string;
          json: string;
        }) => void)
      | null = null;
    const first = new Promise<{
      reportId: string;
      markdown: string;
      json: string;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    let activePreparations = 0;
    let maxActivePreparations = 0;
    hostMocks.prepare.mockImplementation(async (manifest: LogDiagnosticManifest) => {
      activePreparations += 1;
      maxActivePreparations = Math.max(
        maxActivePreparations,
        activePreparations,
      );
      try {
        if (hostMocks.prepare.mock.calls.length === 1) return await first;
        const note = manifest.userNote ?? "(none)";
        return {
          reportId: "cdlogdiag-0000000000000002-0000000000000002",
          markdown: `# Latest\n${note}`,
          json: JSON.stringify({ note }),
        };
      } finally {
        activePreparations -= 1;
      }
    });

    try {
      const { unmount } = render(
        <LogDiagnosticDialog
          corpus={corpus}
          environment={{
            appVersion: "0.1.0",
            channel: "dev",
            gitSha: "de43caeba66df05068a50db9356efad3b64a4a45",
            os: "macOS",
          }}
          currentStatus={null}
          onDismiss={vi.fn()}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREPARE_DEBOUNCE_MS);
      });
      expect(hostMocks.prepare).toHaveBeenCalledTimes(1);

      const note = screen.getByLabelText(/Optional reproduction note/);
      for (let index = 1; index <= 10; index += 1) {
        fireEvent.change(note, { target: { value: `note generation ${index}` } });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PREPARE_DEBOUNCE_MS);
        });
      }
      expect(hostMocks.prepare).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirst?.({
          reportId: "cdlogdiag-0000000000000001-0000000000000001",
          markdown: "# Stale",
          json: "{}",
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(hostMocks.prepare).toHaveBeenCalledTimes(2);
      expect(maxActivePreparations).toBe(1);
      expect(hostMocks.release).toHaveBeenCalledWith(
        "cdlogdiag-0000000000000001-0000000000000001",
      );
      const preview = screen.getByLabelText("Markdown diagnostic preview");
      expect(preview.textContent).toContain("note generation 10");

      fireEvent.click(screen.getByRole("button", { name: "Save Markdown…" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(hostMocks.save).toHaveBeenCalledWith(
        "cdlogdiag-0000000000000002-0000000000000002",
        "markdown",
      );
      unmount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(hostMocks.release).toHaveBeenCalledWith(
        "cdlogdiag-0000000000000002-0000000000000002",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
