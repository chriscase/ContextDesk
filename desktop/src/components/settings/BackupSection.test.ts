import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "BackupSection.tsx"), "utf8");
const hostSource = readFileSync(join(here, "..", "..", "lib", "host.ts"), "utf8");

describe("S3 backup settings security boundary (#419)", () => {
  it("has no raw credential input or save field", () => {
    expect(source).not.toContain("SecretField");
    expect(source).not.toMatch(/access[_A-Z]?key.*onChange/i);
    expect(source).not.toMatch(/secret[_A-Z]?key.*onChange/i);
    const saveBridge = hostSource.slice(
      hostSource.indexOf("export async function hostSaveS3BackupSettings"),
      hostSource.indexOf("export async function hostRunS3WorkspaceBackup"),
    );
    expect(saveBridge).not.toMatch(/access_key\s*:/);
    expect(saveBridge).not.toMatch(/secret_key\s*:/);
    expect(saveBridge).not.toMatch(/session_token\s*:/);
  });

  it("exposes dry run, trusted product command, cancellation, and honest limits", () => {
    expect(source).toContain("hostRunS3WorkspaceBackup");
    expect(source).toContain("hostCancelS3WorkspaceBackup");
    expect(source).toContain("Dry run");
    expect(source).toContain("Back up workspace");
    expect(source).toContain("no restore");
    expect(source).toContain("remote deletion");
    expect(source).toContain("S3 index source");
  });
});
