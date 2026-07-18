/**
 * Structural proof for #147: SettingsModal is a thin shell; each NAV section
 * has its own component; secrets stay out of setup via transient drafts.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const shellPath = join(here, "..", "SettingsModal.tsx");
const controllerPath = join(here, "useSettingsController.ts");

const SECTION_FILES = [
  "PreflightSection.tsx",
  "WorkspaceSection.tsx",
  "AiSection.tsx",
  "ConnectorsSection.tsx",
  "AppearanceSection.tsx",
  "GeneralSection.tsx",
] as const;

function lineCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").length;
}

describe("SettingsModal split (#147)", () => {
  it("each NAV section has its own component under settings/", () => {
    for (const name of SECTION_FILES) {
      const p = join(here, name);
      expect(existsSync(p), `missing ${name}`).toBe(true);
      const src = readFileSync(p, "utf8");
      expect(src).toMatch(/export function \w+Section/);
    }
  });

  it("shell is under ~300 lines and routes to section components", () => {
    const lines = lineCount(shellPath);
    expect(lines).toBeLessThan(300);
    const src = readFileSync(shellPath, "utf8");
    for (const name of SECTION_FILES) {
      const base = name.replace(/\.tsx$/, "");
      expect(src).toContain(base);
    }
    expect(src).toContain("useSettingsController");
  });

  it("dirty tracking and discard-on-close stay centralized in controller", () => {
    const ctrl = readFileSync(controllerPath, "utf8");
    expect(ctrl).toMatch(/const dirty = useMemo/);
    expect(ctrl).toMatch(/Discard them\?/);
    expect(ctrl).toMatch(/shouldResetSettingsOnOpen/);
    // Single save path ends in onSaveSetup
    expect(ctrl).toMatch(/onSaveSetup\(next\)/);
  });

  it("secrets stay transient drafts — never written into setup state", () => {
    const ctrl = readFileSync(controllerPath, "utf8");
    expect(ctrl).toMatch(/apiKeyDraft/);
    expect(ctrl).toMatch(/cfTokenDraft/);
    expect(ctrl).toMatch(/xTokenDraft/);
    // save passes secrets to host keychain helpers, not into next as raw secret fields
    expect(ctrl).toMatch(/hostSaveActiveProvider/);
    expect(ctrl).toMatch(/hostSaveConfluence/);
    expect(ctrl).toMatch(/hostSaveX/);
    // draft wipe clears secrets after save/close
    expect(ctrl).toMatch(/setApiKeyDraft\(""\)/);
    // never assign api key into setup-shaped draft fields
    expect(ctrl).not.toMatch(/setDraft\(\{[^}]*apiKey\s*:/);
  });
});
