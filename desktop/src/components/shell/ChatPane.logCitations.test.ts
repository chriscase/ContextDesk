import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPersistedLogCitation } from "../../lib/citations";

describe("persisted log citation routing (#698)", () => {
  const openExplorer = vi.fn();
  const openExplorerTarget = vi.fn();

  beforeEach(() => {
    openExplorer.mockReset();
    openExplorerTarget.mockReset();
  });

  it("opens the citation's original corpus after detach or replacement", async () => {
    openExplorer.mockResolvedValue("log-explorer-original");
    const unavailable = vi.fn();

    const ok = await openPersistedLogCitation(
      "log_template:7",
      "corpus-original",
      unavailable,
      openExplorer,
    );

    expect(ok).toBe(true);
    expect(openExplorer).toHaveBeenCalledWith("corpus-original");
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("routes event and template through host exact-nav with string ids", async () => {
    openExplorerTarget.mockResolvedValue({
      windowLabel: "log-explorer-c1",
      corpusId: "c1",
      target: { kind: "event", id: "9007199254740993" },
    });
    const unavailable = vi.fn();

    const ok = await openPersistedLogCitation(
      "log_event:9007199254740993",
      "c1",
      unavailable,
      openExplorer,
      openExplorerTarget,
    );

    expect(ok).toBe(true);
    expect(openExplorer).not.toHaveBeenCalled();
    expect(openExplorerTarget).toHaveBeenCalledWith("c1", {
      kind: "event",
      id: "9007199254740993",
    });
    // String identity preserved — not Number-widened.
    const target = openExplorerTarget.mock.calls[0][1];
    expect(target.id).toBe("9007199254740993");
    expect(target.id).not.toBe(String(Number(target.id)));
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("fails visibly when the original corpus was discarded", async () => {
    openExplorer.mockRejectedValue(new Error("corpus not found"));
    const unavailable = vi.fn();

    const ok = await openPersistedLogCitation(
      "log_event:42",
      "corpus-discarded",
      unavailable,
      openExplorer,
    );

    expect(ok).toBe(false);
    expect(unavailable).toHaveBeenCalledWith(
      "log_event:42",
      expect.stringMatching(/original log corpus.*unavailable[\s\S]*not found/i),
    );
  });

  it("fails closed for legacy citations without substituting current context", async () => {
    const unavailable = vi.fn();

    const ok = await openPersistedLogCitation(
      "log_template:7",
      undefined,
      unavailable,
      openExplorer,
    );

    expect(ok).toBe(false);
    expect(openExplorer).not.toHaveBeenCalled();
    expect(openExplorerTarget).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith(
      "log_template:7",
      expect.stringMatching(/does not record.*will not substitute/i),
    );
  });
});
