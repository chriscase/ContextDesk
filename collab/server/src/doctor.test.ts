import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeLocalConfig, LOCAL_DEMO_ENV } from "./config-init.js";
import { runDoctor } from "./doctor.js";

async function localEnv(root: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(root, "web"), { recursive: true });
  return {
    COLLAB_STORAGE: "sqlite",
    COLLAB_SQLITE_PATH: join(root, "collab.sqlite"),
    COLLAB_EVIDENCE_ROOT: join(root, "evidence"),
    COLLAB_STATIC_DIR: join(root, "web"),
    COLLAB_AUTH_MODE: "local",
    COLLAB_LOCAL_USERS: JSON.stringify([
      { username: "lead", password: "not-a-placeholder", displayName: "Case Lead", groups: ["local:case-lead"] },
    ]),
    COLLAB_GROUP_ROLE_MAP: "local:case-lead=case-lead",
    COLLAB_COOKIE_SECURE: "0",
  };
}

describe("collab operator doctor", () => {
  it("accepts a private SQLite configuration without contacting services", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-doctor-"));
    try {
      const report = await runDoctor({ env: await localEnv(root), nodeVersion: "22.5.0" });
      expect(report.ok).toBe(true);
      expect(report.checks.find((item) => item.id === "database")?.status).toBe("ok");
      expect(report.checks.find((item) => item.id === "host-bridge")?.status).toBe("warn");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for external insecure cookies, plaintext LDAP, and malformed profiles", async () => {
    const env: NodeJS.ProcessEnv = {
      COLLAB_DATABASE_URL: "postgres://app:super-secret@example.test/collab",
      COLLAB_MIGRATE_DATABASE_URL: "postgres://migrator:another-secret@example.test/collab",
      COLLAB_HOST: "0.0.0.0",
      COLLAB_COOKIE_SECURE: "0",
      COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      COLLAB_LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=example,dc=test",
      COLLAB_TRIAGE_RUNNER: "/definitely/missing/runner",
      COLLAB_TRIAGE_PROFILE_CATALOG: "not-json",
    };
    const report = await runDoctor({ env, nodeVersion: "22.5.0" });
    expect(report.ok).toBe(false);
    expect(report.checks.some((item) => item.id === "cookie-security" && item.status === "error")).toBe(true);
    expect(report.checks.some((item) => item.id === "authentication" && item.status === "error")).toBe(true);
    expect(report.checks.some((item) => item.id === "triage-profiles" && item.status === "error")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("super-secret");
    expect(JSON.stringify(report)).not.toContain("another-secret");
  });
});

describe("local config initializer", () => {
  it("writes a private template and refuses accidental overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-config-init-"));
    try {
      const target = join(root, "nested", ".env.local");
      await initializeLocalConfig(target);
      expect(await readFile(target, "utf8")).toBe(LOCAL_DEMO_ENV);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "nested", ".data", "evidence"))).isDirectory()).toBe(true);
      await expect(initializeLocalConfig(target)).rejects.toThrow(/already exists/);
      await initializeLocalConfig(target, true);
      await access(target, fsConstants.R_OK);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
