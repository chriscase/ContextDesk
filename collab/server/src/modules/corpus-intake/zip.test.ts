import { describe, expect, it } from "vitest";
import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts";
import { buildTestZip, extractZip, normalizeIntakePath, ZipError } from "./zip.js";

const LOG = new TextEncoder().encode("2026-08-15T00:00:00Z mailer timeout id=syn-1\n");
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;

function names(result: ReturnType<typeof extractZip>): string[] {
  return result.members.map((row) => row.relativePath);
}

function reasons(result: ReturnType<typeof extractZip>): string[] {
  return result.rejected.map((row) => row.reason);
}

describe("normalizeIntakePath", () => {
  it("rejects zip-slip, absolute, drive, UNC, NUL, depth, and length", () => {
    expect(normalizeIntakePath("../etc/passwd").reason).toBe("path_traversal");
    expect(normalizeIntakePath("mailer/./secret.log").reason).toBe("path_traversal");
    expect(normalizeIntakePath("/var/log/mailer.log").reason).toBe("absolute_path");
    expect(normalizeIntakePath("C:/Windows/mailer.log").reason).toBe("drive_or_unc_path");
    expect(normalizeIntakePath("//fileserver/share/mailer.log").reason).toBe("drive_or_unc_path");
    expect(normalizeIntakePath("mailer\0.log").reason).toBe("nul_in_path");
    expect(normalizeIntakePath("").reason).toBe("empty_path");
    expect(normalizeIntakePath("a/b/c/d/e/f/g/h/i/mailer.log").reason).toBe("path_too_deep");
    expect(normalizeIntakePath(`${"a".repeat(241)}.log`).reason).toBe("path_too_long");
  });

  it("normalizes Unicode to NFC while keeping a readable relative path", () => {
    const nfd = "cafe\u0301/mailer.log";
    const nfc = "café/mailer.log";
    const a = normalizeIntakePath(nfd);
    const b = normalizeIntakePath(nfc);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.path).toBe(b.path);
  });
});

describe("extractZip adversarial matrix", () => {
  it("accepts a synthetic stored log and a deflated log", () => {
    const archive = buildTestZip([
      { name: "mailer/shared-timeout.log", data: LOG, method: 0 },
      { name: "mailer/worker.log", data: LOG, method: 8 },
    ]);
    const extracted = extractZip(archive);
    expect(names(extracted).sort()).toEqual(["mailer/shared-timeout.log", "mailer/worker.log"]);
    expect(extracted.rejected).toEqual([]);
  });

  it("rejects zip-slip variants without writing outside the archive", () => {
    const archive = buildTestZip([
      { name: "../../../etc/passwd", data: LOG },
      { name: "/tmp/mailer.log", data: LOG },
      { name: "C:\\Windows\\mailer.log", data: LOG },
      { name: "//unc/share/mailer.log", data: LOG },
      { name: "mailer/shared-timeout.log", data: LOG },
    ]);
    const extracted = extractZip(archive);
    expect(names(extracted)).toEqual(["mailer/shared-timeout.log"]);
    expect(reasons(extracted)).toEqual(
      expect.arrayContaining(["path_traversal", "absolute_path", "drive_or_unc_path"]),
    );
  });

  it("rejects Unicode and case-fold path collisions", () => {
    const nfc = buildTestZip([
      { name: "café/mailer.log", data: LOG },
      { name: "cafe\u0301/mailer.log", data: new TextEncoder().encode("other\n") },
    ]);
    const folded = buildTestZip([
      { name: "Mailer/App.LOG", data: LOG },
      { name: "mailer/app.log", data: new TextEncoder().encode("other\n") },
    ]);
    expect(reasons(extractZip(nfc))).toContain("duplicate_normalized_path");
    expect(reasons(extractZip(folded))).toContain("duplicate_normalized_path");
  });

  it("rejects symlink, device, and hardlink-like duplicate offsets", () => {
    const symlink = extractZip(
      buildTestZip([{ name: "mailer.link", data: LOG, unixMode: S_IFLNK | 0o777 }]),
    );
    const device = extractZip(
      buildTestZip([{ name: "mailer.dev", data: LOG, unixMode: S_IFCHR | 0o666 }]),
    );
    const volume = extractZip(buildTestZip([{ name: "MAILER", data: LOG, dosAttr: 0x08 }]));
    expect(reasons(symlink)).toContain("symlink_or_hardlink");
    expect(reasons(device)).toContain("device_entry");
    expect(reasons(volume)).toContain("device_entry");

    const first = buildTestZip([
      { name: "mailer/a.log", data: LOG },
      { name: "mailer/b.log", data: LOG },
    ]);
    const patched = Buffer.from(first);
    const secondName = Buffer.byteLength("mailer/b.log");
    patched.writeUInt32LE(0, patched.length - 22 - (46 + secondName) + 42);
    expect(reasons(extractZip(patched))).toContain("symlink_or_hardlink");
  });

  it("rejects nested archives, encrypted entries, and zip64 extra fields", () => {
    const nested = extractZip(buildTestZip([{ name: "mailer/inner.zip", data: LOG }]));
    expect(reasons(nested)).toContain("nested_archive");
    const encrypted = extractZip(
      buildTestZip([{ name: "mailer/secret.log", data: LOG, encrypted: true }]),
    );
    expect(reasons(encrypted)).toContain("encrypted_archive");
    const extra = Buffer.alloc(8);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(4, 2);
    expect(() =>
      extractZip(buildTestZip([{ name: "mailer/huge.log", data: LOG, extra }])),
    ).toThrow(ZipError);
  });

  it("rejects extreme ratios, oversized files, too many files, and truncated archives", () => {
    const zeros = new Uint8Array(80_000);
    const bomb = extractZip(
      buildTestZip([{ name: "mailer/bomb.log", data: zeros, method: 8 }]),
    );
    expect(reasons(bomb)).toContain("extreme_ratio");
    const huge = extractZip(
      buildTestZip([
        {
          name: "mailer/huge.log",
          data: new Uint8Array(CORPUS_INTAKE_LIMITS.maxFileBytes + 1),
        },
      ]),
    );
    expect(reasons(huge)).toContain("file_too_large");
    expect(() =>
      extractZip(
        buildTestZip(
          Array.from({ length: CORPUS_INTAKE_LIMITS.maxFileCount + 1 }, (_, index) => ({
            name: `mailer/n${index}.log`,
            data: LOG,
          })),
        ),
      ),
    ).toThrow(/file count exceeds cap/);
    const truncated = buildTestZip([{ name: "mailer/shared-timeout.log", data: LOG }]).subarray(0, 12);
    expect(() => extractZip(truncated)).toThrow(ZipError);
  });

  it("does not leak file bytes in ZipError messages", () => {
    const secret = "SYNTHETIC_FIXTURE_TOKEN_NOT_A_SECRET";
    try {
      extractZip(new TextEncoder().encode(`PK\x03\x04${secret}`));
      throw new Error("expected ZipError");
    } catch (error) {
      expect(error).toBeInstanceOf(ZipError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
