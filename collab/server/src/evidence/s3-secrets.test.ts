import { inspect } from "node:util";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_S3_SECRET_NAMES,
  EVIDENCE_STORAGE_ERRORS,
} from "./s3-settings.js";
import { loadEvidenceS3Credentials } from "./s3-secrets.js";

const CANARY_ACCESS = "CANARYACCESSKEYIDXX";
const CANARY_SECRET = "canarySecretAccessKeyValue!!";
const CANARY_TOKEN = "canarySessionTokenValue!!";
const AWS_CANARY = "aws-env-canary-must-not-copy";

function staticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
    COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: CANARY_ACCESS,
    COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: CANARY_SECRET,
    ...overrides,
  };
}

function expectRedacted(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  expect(text).not.toContain(CANARY_ACCESS);
  expect(text).not.toContain(CANARY_SECRET);
  expect(text).not.toContain(CANARY_TOKEN);
  expect(text).not.toContain(AWS_CANARY);
  expect(text).not.toMatch(/\/run\/secrets|\/tmp\/|file:/);
}

function expectPubliclyOpaque(value: object) {
  const json = JSON.stringify(value);
  const rendered = inspect(value, { depth: 8, getters: true, showHidden: true });
  expect(json).not.toContain(CANARY_ACCESS);
  expect(json).not.toContain(CANARY_SECRET);
  expect(json).not.toContain(CANARY_TOKEN);
  expect(json).not.toContain(AWS_CANARY);
  expect(rendered).not.toContain(CANARY_ACCESS);
  expect(rendered).not.toContain(CANARY_SECRET);
  expect(rendered).not.toContain(CANARY_TOKEN);
  expect(rendered).not.toContain(AWS_CANARY);
  expect(Object.values(value)).not.toContain(CANARY_ACCESS);
  expect(Object.values(value)).not.toContain(CANARY_SECRET);
}

describe("evidence s3 credentials default_chain", () => {
  it("requires explicit default_chain or static mode", () => {
    expect(() => loadEvidenceS3Credentials({})).toThrow(
      EVIDENCE_STORAGE_ERRORS.credentialsMode,
    );
  });

  it("does not copy AWS environment credentials into application objects", () => {
    const credentials = loadEvidenceS3Credentials({
      COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
      AWS_ACCESS_KEY_ID: AWS_CANARY,
      AWS_SECRET_ACCESS_KEY: CANARY_SECRET,
      AWS_SESSION_TOKEN: CANARY_TOKEN,
    });
    expect(credentials.mode).toBe("default_chain");
    expect(credentials.toJSON()).toEqual({ mode: "default_chain" });
    expectPubliclyOpaque(credentials);
    expect(JSON.stringify(credentials)).toBe('{"mode":"default_chain"}');
  });

  it("rejects leftover static credential sources in default_chain mode", () => {
    for (const name of EVIDENCE_S3_SECRET_NAMES) {
      expect(() =>
        loadEvidenceS3Credentials({
          COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
          [name]: "",
        }),
      ).toThrow(EVIDENCE_STORAGE_ERRORS.defaultChainLeftover);
    }
  });
});

describe("evidence s3 credentials static source matrix", () => {
  it("loads the direct environment pair and keeps contents off inspect/JSON", () => {
    const credentials = loadEvidenceS3Credentials(staticEnv());
    expect(credentials.mode).toBe("static");
    if (credentials.mode !== "static") throw new Error("expected static");
    expect(credentials.accessKeyId()).toBe(CANARY_ACCESS);
    expect(credentials.secretAccessKey()).toBe(CANARY_SECRET);
    expect(credentials.sessionToken()).toBeUndefined();
    expect(credentials.toJSON()).toEqual({ mode: "static", configured: true });
    expectPubliclyOpaque(credentials);
  });

  it("accepts an optional session token only with the key/secret pair", () => {
    const credentials = loadEvidenceS3Credentials(
      staticEnv({ COLLAB_EVIDENCE_S3_SESSION_TOKEN: CANARY_TOKEN }),
    );
    if (credentials.mode !== "static") throw new Error("expected static");
    expect(credentials.sessionToken()).toBe(CANARY_TOKEN);
    expectPubliclyOpaque(credentials);
    expect(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_SESSION_TOKEN: CANARY_TOKEN,
      }),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.tokenWithoutPair);
  });

  it("fails closed on missing pair, source conflicts, blank, NUL, and oversize values", () => {
    expect(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: CANARY_ACCESS,
      }),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.missingStaticPair);
    expect(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: CANARY_ACCESS,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: CANARY_SECRET,
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: "/run/secrets/ignored",
      }),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.sourceConflict);
    expect(() =>
      loadEvidenceS3Credentials(staticEnv({ COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: "" })),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
    expect(() =>
      loadEvidenceS3Credentials(
        staticEnv({ COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: `${CANARY_SECRET}\0more` }),
      ),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
    expect(() =>
      loadEvidenceS3Credentials(
        staticEnv({ COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: "a".repeat(16 * 1024 + 1) }),
      ),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
    try {
      loadEvidenceS3Credentials(
        staticEnv({ COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: `${CANARY_SECRET}\0more` }),
      );
    } catch (error) {
      expectRedacted(error);
    }
  });

  it("loads owner-only _FILE and absolute file: _REF sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-secret-"));
    const access = join(dir, "access");
    const secret = join(dir, "secret");
    await writeFile(access, `${CANARY_ACCESS}\n`, { mode: 0o600 });
    await writeFile(secret, `${CANARY_SECRET}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(access, 0o600);
      await chmod(secret, 0o600);
    }
    try {
      const fromFile = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: secret,
      });
      if (fromFile.mode !== "static") throw new Error("expected static");
      expect(fromFile.accessKeyId()).toBe(CANARY_ACCESS);
      expect(fromFile.secretAccessKey()).toBe(CANARY_SECRET);
      expectPubliclyOpaque(fromFile);

      const fromRef = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: `file:${access}`,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
      });
      if (fromRef.mode !== "static") throw new Error("expected static");
      expect(fromRef.accessKeyId()).toBe(CANARY_ACCESS);
      expectPubliclyOpaque(fromRef);

      const token = join(dir, "token");
      await writeFile(token, `${CANARY_TOKEN}\n`, { mode: 0o600 });
      if (process.platform !== "win32") await chmod(token, 0o600);
      const withTokenFiles = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
        COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE: token,
      });
      if (withTokenFiles.mode !== "static") throw new Error("expected static");
      expect(withTokenFiles.sessionToken()).toBe(CANARY_TOKEN);
      expectPubliclyOpaque(withTokenFiles);

      const withTokenRef = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: `file:${access}`,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: secret,
        COLLAB_EVIDENCE_S3_SESSION_TOKEN_REF: `file:${token}`,
      });
      if (withTokenRef.mode !== "static") throw new Error("expected static");
      expect(withTokenRef.sessionToken()).toBe(CANARY_TOKEN);
      expectPubliclyOpaque(withTokenRef);

      for (const baseName of [
        "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID",
        "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY",
        "COLLAB_EVIDENCE_S3_SESSION_TOKEN",
      ]) {
        expect(() =>
          loadEvidenceS3Credentials({
            ...staticEnv({ COLLAB_EVIDENCE_S3_SESSION_TOKEN: CANARY_TOKEN }),
            [baseName]: baseName.endsWith("ACCESS_KEY_ID")
              ? CANARY_ACCESS
              : baseName.endsWith("SECRET_ACCESS_KEY")
                ? CANARY_SECRET
                : CANARY_TOKEN,
            [`${baseName}_FILE`]: token,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.sourceConflict);
      }

      expect(() =>
        loadEvidenceS3Credentials({
          COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
          COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: "file:./access",
          COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
        }),
      ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
      expect(() =>
        loadEvidenceS3Credentials({
          COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
          COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: `file://${access}`,
          COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
        }),
      ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects relative secret files without echoing the path", () => {
    expect(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: "secrets/access",
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: "secrets/secret",
      }),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
  });
});

describe("evidence s3 credential files", () => {
  it.skipIf(process.platform === "win32")(
    "rejects world-readable, symlink, empty, NUL, and oversize secret files",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-secret-unix-"));
      const secret = join(dir, "secret");
      const access = join(dir, "access");
      const world = join(dir, "world");
      const group = join(dir, "group");
      const empty = join(dir, "empty");
      const nul = join(dir, "nul");
      const oversize = join(dir, "oversize");
      const link = join(dir, "link");
      const nested = join(dir, "nested");
      await mkdir(nested);
      await writeFile(access, CANARY_ACCESS, { mode: 0o600 });
      await writeFile(secret, CANARY_SECRET, { mode: 0o600 });
      await writeFile(world, CANARY_SECRET, { mode: 0o644 });
      await writeFile(group, CANARY_SECRET, { mode: 0o640 });
      await writeFile(empty, "", { mode: 0o600 });
      await writeFile(nul, `${CANARY_SECRET}\0x`, { mode: 0o600 });
      await writeFile(oversize, "a".repeat(16 * 1024 + 1), { mode: 0o600 });
      await chmod(access, 0o600);
      await chmod(secret, 0o600);
      await chmod(world, 0o644);
      await chmod(group, 0o640);
      await symlink(secret, link);
      try {
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: world,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: group,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: link,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${link}`,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: empty,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: nul,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: oversize,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: nested,
          }),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("still enforces regular-file and path bounds on every platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-secret-portable-"));
    const access = join(dir, "access");
    await writeFile(access, CANARY_ACCESS, { mode: 0o600 });
    try {
      expect(() =>
        loadEvidenceS3Credentials({
          COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
          COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
          COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: dir,
        }),
      ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
