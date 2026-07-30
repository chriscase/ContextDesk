import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPersistedLogCitation } from "../../lib/citations";

describe("persisted log citation routing (#698)", () => {
  const openExplorer = vi.fn();

  beforeEach(() => {
    openExplorer.mockReset();
  });

  it("opens the citation's original corpus after detach or replacement", async () => {
    openExplorer.mockResolvedValue("log-explorer-original");
    const unavailable = vi.fn();

    await openPersistedLogCitation(
      "log_template:7",
      "corpus-original",
      unavailable,
      openExplorer,
    );

    expect(openExplorer).toHaveBeenCalledWith("corpus-original");
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("fails visibly when the original corpus was discarded", async () => {
    openExplorer.mockRejectedValue(new Error("corpus not found"));
    const unavailable = vi.fn();

    await openPersistedLogCitation(
      "log_event:42",
      "corpus-discarded",
      unavailable,
      openExplorer,
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
      openExplorer,
    );

    expect(openExplorer).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith(
      "log_template:7",
      expect.stringMatching(/does not record.*will not substitute/i),
    );
  });
});
