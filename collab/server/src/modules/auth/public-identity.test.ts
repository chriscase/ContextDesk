import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp, type SecurityDeps } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { HmacPublicIdentityCodec, loadPublicIdentityCodec } from "./public-identity.js";

const KEY = Buffer.alloc(32, 7);
const ALICE_DN = "CN=Alice Fixture,OU=People,DC=example,DC=test";

describe("public identity projection", () => {
  it("derives stable installation-scoped ids without exposing the directory subject", () => {
    const north = new HmacPublicIdentityCodec(KEY);
    const sameInstallation = new HmacPublicIdentityCodec(KEY);
    const west = new HmacPublicIdentityCodec(Buffer.alloc(32, 8));
    const publicId = north.publicId(ALICE_DN);

    expect(publicId).toMatch(/^usr-[a-f0-9]{32}$/);
    expect(sameInstallation.publicId(ALICE_DN.toLocaleLowerCase("en-US"))).toBe(publicId);
    expect(west.publicId(ALICE_DN)).not.toBe(publicId);
    expect(publicId).not.toContain("Alice");
    expect(north.publicId("local:alice")).toBe("local:alice");
  });

  it("canonicalizes supported case and insignificant spacing but refuses ambiguous DN syntax", () => {
    const codec = new HmacPublicIdentityCodec(KEY);
    const canonical = codec.publicId("cn=alice fixture,ou=people,dc=example,dc=test");
    expect(codec.publicId(" CN = ALICE   FIXTURE , OU=People, DC=Example, DC=Test ")).toBe(canonical);
    expect(() => codec.publicId("CN=Doe\\, Alice,OU=People,DC=example,DC=test"))
      .toThrow(/cannot be safely canonicalized/);
    expect(() => codec.publicId("customTenant=North,OU=People,DC=example,DC=test"))
      .toThrow(/cannot be safely canonicalized/);
    expect(() => codec.publicId("customTenant=North,customOrg=Example"))
      .toThrow(/cannot be safely canonicalized/);
    expect(codec.containsDirectoryDn("owner CN=Doe\\, Alice,OU=People,DC=example,DC=test"))
      .toBe(true);
    expect(codec.sanitizeText("cost=unknown,usage=unknown")).toBe("cost=unknown,usage=unknown");
  });

  it("sanitizes nested legacy ids, payload strings, and object keys", () => {
    const codec = new HmacPublicIdentityCodec(KEY);
    const projected = codec.sanitizePayload({
      actorId: ALICE_DN,
      payload: JSON.stringify({ owner: ALICE_DN }),
      [ALICE_DN]: { subjects: [ALICE_DN] },
    });
    const bytes = JSON.stringify(projected);

    expect(bytes).not.toContain(ALICE_DN);
    expect(bytes).not.toMatch(/(?:CN|OU|DC)=/i);
    expect(bytes.match(/usr-[a-f0-9]{32}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("scans large benign key-value payloads without treating them as directory identities", () => {
    const codec = new HmacPublicIdentityCodec(KEY);
    const payload = "cost=unknown,usage=unknown;".repeat(20_000);
    expect(codec.sanitizeText(payload)).toBe(payload);
    expect(codec.containsDirectoryDn(payload)).toBe(false);
  });

  it("reloads the same durable key and rejects malformed configured keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-public-identity-"));
    try {
      const [first, raced] = await Promise.all([
        loadPublicIdentityCodec(root),
        loadPublicIdentityCodec(root),
      ]);
      const second = await loadPublicIdentityCodec(root);
      expect(second.publicId(ALICE_DN)).toBe(first.publicId(ALICE_DN));
      expect(raced.publicId(ALICE_DN)).toBe(first.publicId(ALICE_DN));
      const keyPath = join(root, "public-identity-key");
      if (process.platform !== "win32") {
        expect((await stat(keyPath)).mode & 0o077).toBe(0);
        await chmod(keyPath, 0o644);
        await expect(loadPublicIdentityCodec(root)).rejects.toThrow(/permissions/);
      }
      await expect(loadPublicIdentityCodec(root, "too-short")).rejects.toThrow(/32 bytes/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an authenticated production app without a durable codec", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-public-identity-required-"));
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(buildApp({
        config: testConfig({ evidenceRoot: root }),
        pool: null,
        store: new FilesystemEvidenceStore({ rootDir: root }),
        security: {} as SecurityDeps,
      })).rejects.toThrow(/durable public identity codec is required/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
