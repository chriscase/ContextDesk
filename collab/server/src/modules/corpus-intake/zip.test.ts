import { describe, expect, it } from "vitest";
import { CORPUS_INTAKE_LIMITS } from "@cd-collab/contracts";
import {
  buildTestZip,
  buildUnicodePathExtra,
  extractZip,
  normalizeIntakePath,
  ZipError,
} from "./zip.js";

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
  it("rejects zip-slip, absolute, drive, UNC, NUL, depth, and length", async () => {
    expect(normalizeIntakePath("../etc/passwd").reason).toBe("path_traversal");
    expect(normalizeIntakePath("mailer/./secret.log").reason).toBe("path_traversal");
    expect(normalizeIntakePath("/var/log/mailer.log").reason).toBe("absolute_path");
    expect(normalizeIntakePath("C:/Windows/mailer.log").reason).toBe("drive_or_unc_path");
    expect(normalizeIntakePath("//fileserver/share/mailer.log").reason).toBe("drive_or_unc_path");
    expect(normalizeIntakePath("mailer\0.log").reason).toBe("nul_in_path");
    expect(normalizeIntakePath("").reason).toBe("empty_path");
    expect(normalizeIntakePath("a/b/c/d/e/f/g/file.log").ok).toBe(true);
    expect(normalizeIntakePath("a/b/c/d/e/f/g/h/i/mailer.log").reason).toBe("path_too_deep");
    expect(normalizeIntakePath(`${"a".repeat(236)}.log`).ok).toBe(true);
    expect(normalizeIntakePath(`${"a".repeat(241)}.log`).reason).toBe("path_too_long");
  });

  it("normalizes Unicode to NFC while keeping a readable relative path", async () => {
    const nfd = "cafe\u0301/mailer.log";
    const nfc = "café/mailer.log";
    const a = normalizeIntakePath(nfd);
    const b = normalizeIntakePath(nfc);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.path).toBe(b.path);
  });
});

describe("extractZip adversarial matrix", () => {
  it("accepts a synthetic stored log and a deflated log", async () => {
    const archive = buildTestZip([
      { name: "mailer/shared-timeout.log", data: LOG, method: 0 },
      { name: "mailer/worker.log", data: LOG, method: 8 },
    ]);
    const extracted = await extractZip(archive);
    expect(names(extracted).sort()).toEqual(["mailer/shared-timeout.log", "mailer/worker.log"]);
    expect(extracted.rejected).toEqual([]);
  });

  it("ignores macOS transport metadata instead of presenting it as evidence noise", async () => {
    const result = await extractZip(buildTestZip([
      { name: "incident/service.log", data: LOG },
      { name: "incident/.DS_Store", data: LOG },
      { name: "__MACOSX/incident/._service.log", data: LOG },
    ]));
    expect(result.members.map((member) => member.relativePath)).toEqual(["incident/service.log"]);
    expect(result.rejected).toEqual([]);
  });

  it("does not count bounded macOS transport metadata against the evidence-file cap", async () => {
    const metadata = Array.from({ length: CORPUS_INTAKE_LIMITS.maxFileCount }, (_, index) => ({
      name: `__MACOSX/incident/._metadata-${index}`,
      data: LOG,
    }));
    const result = await extractZip(buildTestZip([
      ...metadata,
      { name: "incident/service.log", data: LOG },
    ]));
    expect(result.members.map((member) => member.relativePath)).toEqual(["incident/service.log"]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects zip-slip variants without writing outside the archive", async () => {
    const archive = buildTestZip([
      { name: "../../../etc/passwd", data: LOG },
      { name: "/tmp/mailer.log", data: LOG },
      { name: "C:\\Windows\\mailer.log", data: LOG },
      { name: "//unc/share/mailer.log", data: LOG },
      { name: "mailer/shared-timeout.log", data: LOG },
    ]);
    const extracted = await extractZip(archive);
    expect(names(extracted)).toEqual(["mailer/shared-timeout.log"]);
    expect(reasons(extracted)).toEqual(
      expect.arrayContaining(["path_traversal", "absolute_path", "drive_or_unc_path"]),
    );
  });

  it("rejects Unicode and case-fold path collisions", async () => {
    const nfc = buildTestZip([
      { name: "café/mailer.log", data: LOG },
      { name: "cafe\u0301/mailer.log", data: new TextEncoder().encode("other\n") },
    ]);
    const folded = buildTestZip([
      { name: "Mailer/App.LOG", data: LOG },
      { name: "mailer/app.log", data: new TextEncoder().encode("other\n") },
    ]);
    expect(reasons(await extractZip(nfc))).toContain("duplicate_normalized_path");
    expect(reasons(await extractZip(folded))).toContain("duplicate_normalized_path");
  });

  it("rejects symlink, device, and hardlink-like duplicate offsets", async () => {
    const symlink = await extractZip(
      buildTestZip([{ name: "mailer.link", data: LOG, unixMode: S_IFLNK | 0o777 }]),
    );
    const device = await extractZip(
      buildTestZip([{ name: "mailer.dev", data: LOG, unixMode: S_IFCHR | 0o666 }]),
    );
    const volume = await extractZip(buildTestZip([{ name: "MAILER", data: LOG, dosAttr: 0x08 }]));
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
    expect(reasons(await extractZip(patched))).toContain("symlink_or_hardlink");
  });

  it("rejects nested archives and encrypted entries", async () => {
    const nested = await extractZip(buildTestZip([{ name: "mailer/inner.zip", data: LOG }]));
    expect(reasons(nested)).toContain("nested_archive");
    const encrypted = await extractZip(
      buildTestZip([{ name: "mailer/secret.log", data: LOG, encrypted: true }]),
    );
    expect(reasons(encrypted)).toContain("encrypted_archive");
  });

  it("reads ZIP64 sizes and directories instead of refusing the archive", async () => {
    // Modern archivers emit ZIP64 for ordinary archives. Refusing the format
    // outright rejected legitimate evidence without narrowing any limit, since
    // the caps below are enforced identically either way.
    const perEntry = await extractZip(
      buildTestZip([{ name: "mailer/shared-timeout.log", data: LOG, zip64: true }]),
    );
    expect(perEntry.rejected).toEqual([]);
    expect(perEntry.members.map((row) => row.relativePath)).toEqual([
      "mailer/shared-timeout.log",
    ]);
    expect(Buffer.from(perEntry.members[0]!.bytes).toString("utf8"))
      .toBe(Buffer.from(LOG).toString("utf8"));

    const zip64Directory = await extractZip(
      buildTestZip(
        [
          { name: "mailer/a.log", data: LOG, zip64: true },
          { name: "mailer/b.log", data: LOG, method: 8, zip64: true },
        ],
        { zip64Directory: true },
      ),
    );
    expect(zip64Directory.rejected).toEqual([]);
    expect(zip64Directory.members.map((row) => row.relativePath)).toEqual([
      "mailer/a.log",
      "mailer/b.log",
    ]);
  });

  it("still enforces every cap on a ZIP64 archive", async () => {
    const zeros = new Uint8Array(80_000);
    const bomb = await extractZip(
      buildTestZip(
        [{ name: "mailer/bomb.log", data: zeros, method: 8, zip64: true }],
        { zip64Directory: true },
      ),
    );
    expect(reasons(bomb)).toContain("extreme_ratio");
    const traversal = await extractZip(
      buildTestZip(
        [{ name: "../escape.log", data: LOG, zip64: true }],
        { zip64Directory: true },
      ),
    );
    expect(reasons(traversal)).toContain("path_traversal");
  });

  it("refuses a truncated ZIP64 extra rather than reading past it", async () => {
    // A short extra that carries no ZIP64 placeholder is inert metadata and
    // must not fail an otherwise ordinary archive.
    const inert = Buffer.alloc(8);
    inert.writeUInt16LE(0x0001, 0);
    inert.writeUInt16LE(4, 2);
    const ignored = await extractZip(
      buildTestZip([{ name: "mailer/huge.log", data: LOG, extra: inert }]),
    );
    expect(ignored.members.map((row) => row.relativePath)).toEqual(["mailer/huge.log"]);

    // A ZIP64-flagged entry whose extra stops short of the sizes it promised is
    // malformed; reading past it would take whatever bytes followed.
    await expect(
      extractZip(buildTestZip([
        { name: "mailer/short.log", data: LOG, zip64: true, zip64TruncatedExtra: true },
      ])),
    ).rejects.toThrow(/ZIP64 extra field is truncated/);
  });

  it("rejects extreme ratios, too many files, and truncated archives", async () => {
    const zeros = new Uint8Array(80_000);
    const bomb = await extractZip(
      buildTestZip([{ name: "mailer/bomb.log", data: zeros, method: 8 }]),
    );
    expect(reasons(bomb)).toContain("extreme_ratio");
    await expect(
      extractZip(
        buildTestZip(
          Array.from({ length: CORPUS_INTAKE_LIMITS.maxFileCount + 1 }, (_, index) => ({
            name: `mailer/n${index}.log`,
            data: LOG,
          })),
        ),
      )
    ).rejects.toThrow(/file count exceeds cap/);
    const truncated = buildTestZip([{ name: "mailer/shared-timeout.log", data: LOG }]).subarray(0, 12);
    await expect(extractZip(truncated)).rejects.toThrow(ZipError);
  });

  it("rejects invalid encodings and ZIP names that omit the UTF-8 language bit", async () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from("mailer/"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(".log"),
    ]);
    const invalid = await extractZip(
      buildTestZip([{ name: "mailer/placeholder.log", data: LOG, nameBytes: invalidUtf8, flags: 0x0800 }]),
    );
    expect(reasons(invalid)).toContain("invalid_encoding");
    expect(names(invalid)).toEqual([]);
    expect(invalid.rejected.every((row) => !row.detail.includes("\uFFFD"))).toBe(true);

    const unmarked = await extractZip(
      buildTestZip([{ name: "café/mailer.log", data: LOG, flags: 0 }]),
    );
    expect(reasons(unmarked)).toContain("invalid_encoding");
    expect(names(unmarked)).toEqual([]);

    const marked = await extractZip(buildTestZip([{ name: "café/mailer.log", data: LOG, flags: 0x0800 }]));
    expect(names(marked)).toEqual(["café/mailer.log"]);
    expect(marked.rejected).toEqual([]);

    const ascii = await extractZip(buildTestZip([{ name: "mailer/shared-timeout.log", data: LOG, flags: 0 }]));
    expect(names(ascii)).toEqual(["mailer/shared-timeout.log"]);

    const mixed = await extractZip(
      buildTestZip([
        { name: "mailer/shared-timeout.log", data: LOG },
        { name: "mailer/placeholder.log", data: LOG, nameBytes: invalidUtf8, flags: 0x0800 },
      ]),
    );
    expect(names(mixed)).toEqual(["mailer/shared-timeout.log"]);
    expect(reasons(mixed)).toContain("invalid_encoding");

    const disagreed = Buffer.from(buildTestZip([{ name: "café/mailer.log", data: LOG, flags: 0x0800 }]));
    disagreed.writeUInt16LE(0, 6);
    await expect(extractZip(disagreed)).rejects.toThrow(/encoding does not match/);
  });

  it("honors Info-ZIP Unicode Path extra 0x7075 fail-closed", async () => {
    const asciiName = "mailer/notes.log";
    const traversal = await extractZip(
      buildTestZip([
        {
          name: asciiName,
          data: LOG,
          flags: 0,
          extra: buildUnicodePathExtra(asciiName, "../../etc/passwd"),
        },
      ]),
    );
    expect(reasons(traversal)).toContain("path_traversal");
    expect(names(traversal)).toEqual([]);

    const renamed = await extractZip(
      buildTestZip([
        {
          name: "mailer/cafe.log",
          data: LOG,
          flags: 0,
          extra: buildUnicodePathExtra("mailer/cafe.log", "mailer/café.log"),
        },
      ]),
    );
    expect(names(renamed)).toEqual(["mailer/café.log"]);
    expect(renamed.rejected).toEqual([]);

    const badCrc = Buffer.from(buildUnicodePathExtra(asciiName, "mailer/other.log"));
    badCrc.writeUInt32LE(0, 5);
    await expect(
      extractZip(buildTestZip([{ name: asciiName, data: LOG, flags: 0, extra: badCrc }]))
    ).rejects.toThrow(/Unicode Path extra CRC/);

    const invalidUtf8Extra = Buffer.from(buildUnicodePathExtra(asciiName, "mailer/x.log"));
    invalidUtf8Extra.writeUInt8(0xff, invalidUtf8Extra.length - 5);
    const undecodable = await extractZip(
      buildTestZip([{ name: asciiName, data: LOG, flags: 0, extra: invalidUtf8Extra }]),
    );
    expect(reasons(undecodable)).toContain("invalid_encoding");
    expect(names(undecodable)).toEqual([]);
    expect(undecodable.rejected.every((row) => !row.detail.includes("\uFFFD"))).toBe(true);

    const unmarkedBytes = Buffer.from("café/mailer.log", "utf8");
    const recovered = await extractZip(
      buildTestZip([
        {
          name: "placeholder.log",
          data: LOG,
          flags: 0,
          nameBytes: unmarkedBytes,
          extra: buildUnicodePathExtra(unmarkedBytes, "café/mailer.log"),
        },
      ]),
    );
    expect(names(recovered)).toEqual(["café/mailer.log"]);
    expect(recovered.rejected).toEqual([]);

    await expect(
      extractZip(
        buildTestZip([
          {
            name: "mailer/cafe.log",
            data: LOG,
            flags: 0,
            extra: buildUnicodePathExtra("mailer/cafe.log", "mailer/café.log"),
            localExtra: buildUnicodePathExtra("mailer/cafe.log", "../../etc/passwd"),
          },
        ]),
      )
    ).rejects.toThrow(/Unicode Path extra does not match/);
  });

  it("does not leak file bytes in ZipError messages", async () => {
    const secret = "SYNTHETIC_FIXTURE_TOKEN_NOT_A_SECRET";
    try {
      await extractZip(new TextEncoder().encode(`PK\x03\x04${secret}`));
      throw new Error("expected ZipError");
    } catch (error) {
      expect(error).toBeInstanceOf(ZipError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
