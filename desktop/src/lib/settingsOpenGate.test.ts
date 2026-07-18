import { describe, expect, it } from "vitest";
import { shouldResetSettingsOnOpen } from "./settingsOpenGate";

describe("shouldResetSettingsOnOpen (#157)", () => {
  it("resets only on open transition", () => {
    expect(shouldResetSettingsOnOpen(true, false)).toBe(true);
    expect(shouldResetSettingsOnOpen(true, true)).toBe(false);
    expect(shouldResetSettingsOnOpen(false, true)).toBe(false);
    expect(shouldResetSettingsOnOpen(false, false)).toBe(false);
  });
});
