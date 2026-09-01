import { inspect } from "node:util";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_S3_SECRET_NAMES,
  EVIDENCE_STORAGE_ERRORS,
  readUnfollowedRegularFile,
} from "./s3-settings.js";
import {
  loadEvidenceS3Credentials,
  redactEvidenceS3Error,
  type EvidenceS3CredentialLoaderDeps,
} from "./s3-secrets.js";

const CANARY_ACCESS = "CANARYACCESSKEYIDXX";
const CANARY_SECRET = "canarySecretAccessKeyValue!!";
const CANARY_TOKEN = "canarySessionTokenValue!!";
const AWS_CANARY = "aws-env-canary-must-not-copy";
const WIN32_CANARY_PATH = "C:\\Users\\canary\\secret-access-key";
const WIN32_CANARY_REF = `file:${WIN32_CANARY_PATH}`;
const UNIX_CANARY_ACCESS_PATH = "/run/secrets/canary-access";
const UNIX_CANARY_SECRET_PATH = "/run/secrets/canary-secret";

const unixLoaderDeps: EvidenceS3CredentialLoaderDeps = {
  platform: "linux",
  readUnfollowedRegularFile,
};

function unusedCredentialReader(): Buffer {
  throw new Error("credential file content must not be read");
}

function win32LoaderDeps(
  readUnfollowedRegularFile = unusedCredentialReader,
): EvidenceS3CredentialLoaderDeps {
  return {
    platform: "win32",
    readUnfollowedRegularFile,
  };
}

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
  expect(text).not.toContain(WIN32_CANARY_PATH);
  expect(text).not.toContain(WIN32_CANARY_REF);
  expect(text).not.toContain(UNIX_CANARY_ACCESS_PATH);
  expect(text).not.toContain(UNIX_CANARY_SECRET_PATH);
  expect(text).not.toMatch(/\/run\/secrets|\/tmp\/|C:\\Users\\canary/);
  if (text !== EVIDENCE_STORAGE_ERRORS.credentialFileWindows) {
    expect(text).not.toMatch(/file:/);
  }
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

  it.skipIf(process.platform === "win32")(
    "loads owner-only _FILE and absolute file: _REF sources",
    async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-secret-"));
    const access = join(dir, "access");
    const secret = join(dir, "secret");
    await writeFile(access, `${CANARY_ACCESS}\n`, { mode: 0o600 });
    await writeFile(secret, `${CANARY_SECRET}\n`, { mode: 0o600 });
    await chmod(access, 0o600);
    await chmod(secret, 0o600);
    try {
      const fromFile = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: secret,
      }, unixLoaderDeps);
      if (fromFile.mode !== "static") throw new Error("expected static");
      expect(fromFile.accessKeyId()).toBe(CANARY_ACCESS);
      expect(fromFile.secretAccessKey()).toBe(CANARY_SECRET);
      expectPubliclyOpaque(fromFile);

      const fromRef = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: `file:${access}`,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
      }, unixLoaderDeps);
      if (fromRef.mode !== "static") throw new Error("expected static");
      expect(fromRef.accessKeyId()).toBe(CANARY_ACCESS);
      expectPubliclyOpaque(fromRef);

      const token = join(dir, "token");
      await writeFile(token, `${CANARY_TOKEN}\n`, { mode: 0o600 });
      await chmod(token, 0o600);
      const withTokenFiles = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
        COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE: token,
      }, unixLoaderDeps);
      if (withTokenFiles.mode !== "static") throw new Error("expected static");
      expect(withTokenFiles.sessionToken()).toBe(CANARY_TOKEN);
      expectPubliclyOpaque(withTokenFiles);

      const withTokenRef = loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: `file:${access}`,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: secret,
        COLLAB_EVIDENCE_S3_SESSION_TOKEN_REF: `file:${token}`,
      }, unixLoaderDeps);
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
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.sourceConflict);
      }

      expect(() =>
        loadEvidenceS3Credentials({
          COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
          COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: "file:./access",
          COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
        }, unixLoaderDeps),
      ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
      expect(() =>
        loadEvidenceS3Credentials({
          COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
          COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: `file://${access}`,
          COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${secret}`,
        }, unixLoaderDeps),
      ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    },
  );

  it("rejects relative secret files without echoing the path", () => {
    expect(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: "secrets/access",
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: "secrets/secret",
      }, unixLoaderDeps),
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
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: group,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: link,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${link}`,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: empty,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: nul,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: oversize,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: nested,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "still enforces regular-file and path bounds on injected Unix",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-secret-portable-"));
      const access = join(dir, "access");
      await writeFile(access, CANARY_ACCESS, { mode: 0o600 });
      await chmod(access, 0o600);
      try {
        expect(() =>
          loadEvidenceS3Credentials({
            COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
            COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: access,
            COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: dir,
          }, unixLoaderDeps),
        ).toThrow(EVIDENCE_STORAGE_ERRORS.credentialFile);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("evidence s3 credentials injected win32", () => {
  function expectWin32FileRefusal(run: () => unknown) {
    const platformBefore = process.platform;
    try {
      run();
      throw new Error("expected Windows credential file refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        EVIDENCE_STORAGE_ERRORS.credentialFileWindows,
      );
      expectRedacted(error);
      expect(redactEvidenceS3Error(error)).toBe(
        EVIDENCE_STORAGE_ERRORS.credentialFileWindows,
      );
    }
    expect(process.platform).toBe(platformBefore);
  }

  it("rejects _FILE sources before any filesystem access", () => {
    const deps = win32LoaderDeps();
    expectWin32FileRefusal(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: WIN32_CANARY_PATH,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE: WIN32_CANARY_PATH,
      }, deps),
    );
  });

  it("rejects file: _REF sources before any filesystem access", () => {
    const deps = win32LoaderDeps();
    expectWin32FileRefusal(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: WIN32_CANARY_REF,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: WIN32_CANARY_REF,
      }, deps),
    );
    expectWin32FileRefusal(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF: `file://${WIN32_CANARY_PATH}`,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: CANARY_SECRET,
      }, deps),
    );
  });

  it("rejects a session-token file source even when the key pair is direct", () => {
    const deps = win32LoaderDeps();
    expectWin32FileRefusal(() =>
      loadEvidenceS3Credentials(
        staticEnv({ COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE: WIN32_CANARY_PATH }),
        deps,
      ),
    );
  });

  it("still accepts direct static environment credentials", () => {
    const platformBefore = process.platform;
    const credentials = loadEvidenceS3Credentials(staticEnv(), win32LoaderDeps());
    expect(process.platform).toBe(platformBefore);
    expect(credentials.mode).toBe("static");
    if (credentials.mode !== "static") throw new Error("expected static");
    expect(credentials.accessKeyId()).toBe(CANARY_ACCESS);
    expect(credentials.secretAccessKey()).toBe(CANARY_SECRET);
    expectPubliclyOpaque(credentials);
  });

  it("still accepts default_chain and rejects leftover static names", () => {
    const platformBefore = process.platform;
    const credentials = loadEvidenceS3Credentials({
      COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
      AWS_ACCESS_KEY_ID: AWS_CANARY,
    }, win32LoaderDeps());
    expect(process.platform).toBe(platformBefore);
    expect(credentials.mode).toBe("default_chain");
    expectPubliclyOpaque(credentials);
    expect(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: WIN32_CANARY_PATH,
      }, win32LoaderDeps()),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.defaultChainLeftover);
  });

  it("still fails closed on source conflicts before reading files", () => {
    const platformBefore = process.platform;
    expect(() =>
      loadEvidenceS3Credentials({
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: CANARY_ACCESS,
        COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: CANARY_SECRET,
        COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: WIN32_CANARY_PATH,
      }, win32LoaderDeps()),
    ).toThrow(EVIDENCE_STORAGE_ERRORS.sourceConflict);
    expect(process.platform).toBe(platformBefore);
  });
});

describe("evidence s3 credentials injected unix", () => {
  it("loads _FILE and file: _REF through owner-only reads without mutating process.platform", () => {
    const platformBefore = process.platform;
    const reads: Array<{ path: string; ownerOnly: boolean; platform?: NodeJS.Platform }> = [];
    const credentials = loadEvidenceS3Credentials({
      COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
      COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE: UNIX_CANARY_ACCESS_PATH,
      COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF: `file:${UNIX_CANARY_SECRET_PATH}`,
    }, {
      platform: "linux",
      readUnfollowedRegularFile: (path, options) => {
        reads.push({
          path,
          ownerOnly: options.ownerOnly,
          platform: options.platform,
        });
        if (path === UNIX_CANARY_ACCESS_PATH) return Buffer.from(CANARY_ACCESS);
        if (path === UNIX_CANARY_SECRET_PATH) return Buffer.from(CANARY_SECRET);
        throw new Error("unexpected credential path");
      },
    });
    expect(process.platform).toBe(platformBefore);
    expect(reads).toEqual([
      {
        path: UNIX_CANARY_ACCESS_PATH,
        ownerOnly: true,
        platform: "linux",
      },
      {
        path: UNIX_CANARY_SECRET_PATH,
        ownerOnly: true,
        platform: "linux",
      },
    ]);
    if (credentials.mode !== "static") throw new Error("expected static");
    expect(credentials.accessKeyId()).toBe(CANARY_ACCESS);
    expect(credentials.secretAccessKey()).toBe(CANARY_SECRET);
    expectPubliclyOpaque(credentials);
  });

  it("preserves known credential errors through redaction", () => {
    expect(redactEvidenceS3Error(new Error(EVIDENCE_STORAGE_ERRORS.credentialFileWindows)))
      .toBe(EVIDENCE_STORAGE_ERRORS.credentialFileWindows);
    expect(redactEvidenceS3Error(new Error(`ENOENT ${WIN32_CANARY_PATH}`)))
      .toBe("s3 evidence configuration is invalid");
  });
});
