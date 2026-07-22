import { describe, expect, it } from "vitest";
import {
  mayUseInstallerUpdates,
  shouldPollNow,
  type UpdatePollPrefs,
} from "./updatePoll";

describe("updatePoll (#339)", () => {
  it("default disabled never polls", () => {
    const p: UpdatePollPrefs = {
      enabled: false,
      intervalHours: 24,
      lastCheckAt: null,
    };
    expect(shouldPollNow(p, Date.now())).toBe(false);
  });

  it("enabled with no last check is due", () => {
    const p: UpdatePollPrefs = {
      enabled: true,
      intervalHours: 24,
      lastCheckAt: null,
    };
    expect(shouldPollNow(p, 1_000_000)).toBe(true);
  });

  it("respects interval", () => {
    const p: UpdatePollPrefs = {
      enabled: true,
      intervalHours: 24,
      lastCheckAt: 0,
    };
    expect(shouldPollNow(p, 1000)).toBe(false);
    expect(shouldPollNow(p, 25 * 60 * 60 * 1000)).toBe(true);
  });

  it("only installed channel uses installer updates", () => {
    expect(mayUseInstallerUpdates("installed")).toBe(true);
    expect(mayUseInstallerUpdates("dev")).toBe(false);
    expect(mayUseInstallerUpdates(null)).toBe(false);
  });
});
