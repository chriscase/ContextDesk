import { describe, expect, it, vi } from "vitest";
import { pickWorkspaceDirectory } from "./workspacePicker";

describe("workspace directory picker", () => {
  it("treats native cancellation as a silent no-op", async () => {
    const notifyUnavailable = vi.fn(async () => undefined);

    await expect(
      pickWorkspaceDirectory(async () => null, notifyUnavailable),
    ).resolves.toBeNull();
    expect(notifyUnavailable).not.toHaveBeenCalled();
  });

  it("surfaces genuine picker unavailability", async () => {
    const notifyUnavailable = vi.fn(async () => undefined);

    await expect(
      pickWorkspaceDirectory(async () => {
        throw new Error("dialog plugin unavailable");
      }, notifyUnavailable),
    ).resolves.toBeNull();
    expect(notifyUnavailable).toHaveBeenCalledOnce();
  });

  it("returns the selected directory", async () => {
    const notifyUnavailable = vi.fn(async () => undefined);

    await expect(
      pickWorkspaceDirectory(
        async () => "/Users/example/workspace",
        notifyUnavailable,
      ),
    ).resolves.toBe("/Users/example/workspace");
    expect(notifyUnavailable).not.toHaveBeenCalled();
  });
});
