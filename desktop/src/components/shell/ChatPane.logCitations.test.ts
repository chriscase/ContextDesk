import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPersistedLogCitation } from "./ChatPane";

const host = vi.hoisted(() => ({
  openLogExplorer: vi.fn(),
}));

vi.mock("../../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/host")>();
  return {
    ...original,
    hostOpenLogExplorer: host.openLogExplorer,
  };
});

describe("persisted log citation routing (#698)", () => {
  beforeEach(() => {
    host.openLogExplorer.mockReset();
  });

  it("opens the citation's original corpus after detach or replacement", async () => {
    host.openLogExplorer.mockResolvedValue("log-explorer-original");
    const unavailable = vi.fn();

    await openPersistedLogCitation(
      "log_template:7",
      "corpus-original",
      unavailable,
    );

    expect(host.openLogExplorer).toHaveBeenCalledWith("corpus-original");
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("fails visibly when the original corpus was discarded", async () => {
    host.openLogExplorer.mockRejectedValue(new Error("corpus not found"));
    const unavailable = vi.fn();

    await openPersistedLogCitation(
      "log_event:42",
      "corpus-discarded",
      unavailable,
    );

    expect(unavailable).toHaveBeenCalledWith(
      "log_event:42",
      expect.stringMatching(/original log corpus.*unavailable[\s\S]*not found/i),
    );
  });

  it("fails closed for legacy citations without substituting current context", async () => {
    const unavailable = vi.fn();

    await openPersistedLogCitation(
      "log_template:7",
      undefined,
      unavailable,
    );

    expect(host.openLogExplorer).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith(
      "log_template:7",
      expect.stringMatching(/does not record.*will not substitute/i),
    );
  });
});
