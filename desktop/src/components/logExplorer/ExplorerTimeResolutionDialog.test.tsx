import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LogTimezoneApplyRequestDto,
  LogTimezoneClearRequestDto,
} from "../../lib/host";
import { ExplorerTimeResolutionDialog } from "./ExplorerTimeResolutionDialog";

const hostMocks = vi.hoisted(() => ({
  apply: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  load: vi.fn(async (corpusId: string) => ({
    corpusId,
    eventRevision: 1,
    declarations: {},
    sources: [],
  })),
  preview: vi.fn(),
}));
const bridgeMocks = vi.hoisted(() => ({
  broadcast: vi.fn(async () => undefined),
}));

vi.mock("../../lib/host", () => ({
  hostApplyLogSourceTimezone: hostMocks.apply,
  hostClearLogSourceTimezone: hostMocks.clear,
  hostLoadLogTimezoneState: hostMocks.load,
  hostPreviewLogSourceTimezone: hostMocks.preview,
}));
vi.mock("../../lib/logExplorer/timeRevisionBridge", () => ({
  broadcastTimeRevisionChanged: bridgeMocks.broadcast,
}));
vi.mock("../panes/LogTimezoneStatus", () => ({
  LogTimezoneStatus: ({
    onApply,
    onClear,
  }: {
    onApply: (request: LogTimezoneApplyRequestDto) => Promise<void>;
    onClear: (request: LogTimezoneClearRequestDto) => Promise<void>;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          void onApply({
            corpusId: "corpus-1",
            expectedRevision: 1,
            source: "app.log",
            ianaZone: "America/Chicago",
            previewToken: "preview-1",
          }).catch(() => undefined)
        }
      >
        Apply test timezone
      </button>
      <button
        type="button"
        onClick={() =>
          void onClear({
            corpusId: "corpus-1",
            expectedRevision: 2,
            source: "app.log",
            appliedRevision: 2,
          }).catch(() => undefined)
        }
      >
        Clear test timezone
      </button>
    </>
  ),
}));

describe("ExplorerTimeResolutionDialog revision broadcasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["Apply test timezone", hostMocks.apply],
    ["Clear test timezone", hostMocks.clear],
  ])("broadcasts after a successful %s mutation", async (label, mutate) => {
    render(
      <ExplorerTimeResolutionDialog
        corpusId="corpus-1"
        triggerRef={{ current: null }}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: label }));

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(bridgeMocks.broadcast).toHaveBeenCalledOnce();
    expect(bridgeMocks.broadcast).toHaveBeenCalledWith("corpus-1");
  });

  it("does not broadcast when the host mutation fails", async () => {
    hostMocks.apply.mockRejectedValueOnce(new Error("apply failed"));
    render(
      <ExplorerTimeResolutionDialog
        corpusId="corpus-1"
        triggerRef={{ current: null }}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply test timezone" }),
    );

    await waitFor(() => expect(hostMocks.apply).toHaveBeenCalledOnce());
    expect(bridgeMocks.broadcast).not.toHaveBeenCalled();
  });
});
