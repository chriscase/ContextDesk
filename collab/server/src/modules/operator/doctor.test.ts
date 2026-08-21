import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  doctorExitCode,
  parseDoctorReport,
  renderDoctorSummary,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file.js";
import { nodeOperatorFs, type OperatorFs } from "./fs.js";
import { runDoctor } from "./doctor.js";
import { initConfig, renderConfigFile } from "./config-init.js";

const here = dirname(fileURLToPath(import.meta.url));
const collabRoot = join(here, "../../../..");
const catalogValid = join(collabRoot, "contracts/fixtures/profile-catalog.valid.json");
const catalogUnknown = join(collabRoot, "contracts/fixtures/profile-catalog.unknown-field.json");
const liveCatalogValid = join(collabRoot, "contracts/fixtures/live-qualification-catalog.valid.json");

function memoryFs(
  entries: Record<string, "file" | "dir" | "ro-dir">,
  contents: Record<string, string> = {},
): OperatorFs {
  return {
    exists(path) {
      return path in entries;
    },
    isFile(path) {
      return entries[path] === "file";
    },
    isDirectory(path) {
      return entries[path] === "dir" || entries[path] === "ro-dir";
    },
    isWritableDirectory(path) {
      return entries[path] === "dir";
    },
    readFile(path) {
      if (!(path in contents)) throw new Error("missing file");
      return contents[path] ?? "";
    },
  };
}

function built(root: string): Record<string, "file" | "dir" | "ro-dir"> {
  return {
    [`${root}/contracts/dist/index.js`]: "file",
    [`${root}/server/dist/index.js`]: "file",
    [`${root}/web/dist/index.html`]: "file",
    [`${root}/web/dist`]: "dir",
    [`${root}/.data/evidence`]: "dir",
  };
}

function statusOf(
  report: ReturnType<typeof runDoctor>,
  id: string,
): string | undefined {
  return report.checks.find((check) => check.id === id)?.status;
}

describe("operator doctor", () => {
  it("accepts a local demo configuration", () => {
    const root = "/fixture-collab";
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_COOKIE_SECURE: "0",
        COLLAB_PORT: "8787",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(built(root)),
    });
    parseDoctorReport(report);
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
    expect(statusOf(report, "auth_mode")).toBe("ok");
    expect(statusOf(report, "storage")).toBe("ok");
    expect(statusOf(report, "ldap_tls")).toBe("ok");
    expect(statusOf(report, "cookie_security")).toBe("ok");
  });

  it("accepts a postgres deployment configuration with placeholders", () => {
    const root = "/fixture-collab";
    const env = parseEnvFile(renderConfigFile("postgres"));
    const report = runDoctor({
      env,
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(built(root)),
    });
    expect(report.ok).toBe(true);
    expect(statusOf(report, "storage")).toBe("warn");
    expect(statusOf(report, "cookie_security")).toBe("ok");
    expect(statusOf(report, "ldap_tls")).toBe("ok");
    expect(JSON.stringify(report)).not.toContain("replace-from-secret-store");
  });

  it("accepts encrypted LDAP transport without contacting a directory", () => {
    const root = "/fixture-collab";
    const env = parseEnvFile(renderConfigFile("ldap"));
    const report = runDoctor({
      env,
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(built(root)),
    });
    expect(statusOf(report, "ldap_tls")).toBe("ok");
    expect(statusOf(report, "auth_mode")).toBe("ok");
    expect(renderDoctorSummary(report)).not.toMatch(/ldaps:\/\//);
  });

  it("rejects plaintext LDAP", () => {
    const root = "/fixture-collab";
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "ldap",
        COLLAB_LDAP_URL: "ldap://directory.example.test:389",
        COLLAB_DATABASE_URL: "postgres://collab_app:replace-from-secret-store@127.0.0.1:5432/collab",
        COLLAB_COOKIE_SECURE: "1",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(built(root)),
    });
    expect(report.ok).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
    expect(statusOf(report, "ldap_tls")).toBe("error");
    expect(JSON.stringify(report)).not.toContain("directory.example.test");
  });

  it("warns when the host bridge and live profiles are missing on a deployment", () => {
    const root = "/fixture-collab";
    const report = runDoctor({
      env: parseEnvFile(renderConfigFile("postgres")),
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(built(root)),
    });
    expect(statusOf(report, "rust_bridge")).toBe("warn");
    expect(statusOf(report, "profile_catalog")).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("errors when a configured host bridge path is missing", () => {
    const root = "/fixture-collab";
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_BRIDGE_BIN: "bin/contextdesk",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(built(root)),
    });
    expect(statusOf(report, "rust_bridge")).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("errors on an unwritable evidence path", () => {
    const root = "/fixture-collab";
    const files = built(root);
    files[`${root}/.data/evidence`] = "ro-dir";
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(files),
    });
    expect(statusOf(report, "evidence_root")).toBe("error");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("errors on a malformed profile catalog", () => {
    const root = "/fixture-collab";
    const files = built(root);
    files[`${root}/catalog.json`] = "file";
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_PROFILE_CATALOG: "catalog.json",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(files, {
        [`${root}/catalog.json`]: JSON.stringify({ prompt: "leak" }),
      }),
    });
    expect(statusOf(report, "profile_catalog")).toBe("error");
    expect(JSON.stringify(report)).not.toContain("prompt");
  });

  it("accepts a valid profile catalog without contacting providers", async () => {
    const root = "/fixture-collab";
    const files = built(root);
    files[`${root}/catalog.json`] = "file";
    const body = await readFile(catalogValid, "utf8");
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_PROFILE_CATALOG: "catalog.json",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(files, { [`${root}/catalog.json`]: body }),
    });
    expect(statusOf(report, "profile_catalog")).toBe("ok");
  });

  it("accepts the share-safe live qualification catalog without contacting providers", async () => {
    const root = "/fixture-collab";
    const files = built(root);
    files[`${root}/live-catalog.json`] = "file";
    const body = await readFile(liveCatalogValid, "utf8");
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_LIVE_PROFILE_CATALOG: "live-catalog.json",
        COLLAB_LIVE_PROFILES: "gpt-oss-120b,qwen-3.6-27b",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(files, { [`${root}/live-catalog.json`]: body }),
    });
    expect(statusOf(report, "profile_catalog")).toBe("ok");
  });

  it("rejects unknown-field catalogs", async () => {
    const root = "/fixture-collab";
    const files = built(root);
    files[`${root}/catalog.json`] = "file";
    const body = await readFile(catalogUnknown, "utf8");
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_PROFILE_CATALOG: "catalog.json",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(files, { [`${root}/catalog.json`]: body }),
    });
    expect(statusOf(report, "profile_catalog")).toBe("error");
    expect(JSON.stringify(report)).not.toContain("gateway.example.test");
  });

  it("keeps secrets and credential URLs out of JSON and human output", () => {
    const root = "/fixture-collab";
    const secret = "supersecret-doctor-token";
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "ldap",
        COLLAB_COOKIE_SECURE: "1",
        COLLAB_DATABASE_URL: `postgres://collab_app:${secret}@127.0.0.1:5432/collab`,
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
        COLLAB_LDAP_BIND_PASSWORD: secret,
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs(built(root)),
    });
    const json = JSON.stringify(report);
    const human = renderDoctorSummary(report);
    expect(json).not.toContain(secret);
    expect(human).not.toContain(secret);
    expect(json).not.toContain("postgres://");
    expect(human).not.toContain("postgres://");
    expect(json).not.toMatch(/ldaps:\/\//);
  });

  it("errors on an old Node runtime and an invalid port", () => {
    const root = "/fixture-collab";
    const report = runDoctor({
      env: {
        COLLAB_AUTH_MODE: "local",
        COLLAB_PORT: "not-a-port",
        COLLAB_EVIDENCE_ROOT: ".data/evidence",
      },
      collabRoot: root,
      cwd: root,
      nodeVersion: "18.20.0",
      fs: memoryFs(built(root)),
    });
    expect(statusOf(report, "node_runtime")).toBe("error");
    expect(statusOf(report, "port")).toBe("error");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("errors when compiled artifacts are missing", () => {
    const root = "/fixture-collab";
    const report = runDoctor({
      env: { COLLAB_AUTH_MODE: "local", COLLAB_EVIDENCE_ROOT: ".data/evidence" },
      collabRoot: root,
      cwd: root,
      nodeVersion: "22.5.0",
      fs: memoryFs({ [`${root}/.data/evidence`]: "dir" }),
    });
    expect(statusOf(report, "built_artifacts")).toBe("error");
  });
});
describe("operator config:init", () => {
  it("writes a documented local-demo file and creates the evidence directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-init-"));
    try {
      const result = await initConfig({
        collabRoot,
        cwd: dir,
        output: ".env.local",
        profile: "demo",
        nonInteractive: true,
      });
      const body = await readFile(result.outputPath, "utf8");
      expect(body).toContain("COLLAB_AUTH_MODE=local");
      expect(body).toContain("does not contact PostgreSQL");
      expect(body).not.toMatch(/connected to/i);
      expect(result.createdDirectories.length).toBe(1);
      const probe = join(result.createdDirectories[0] ?? "", ".keep");
      await writeFile(probe, "ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses overwrite unless force is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-init-"));
    try {
      await initConfig({
        collabRoot,
        cwd: dir,
        output: ".env.local",
        profile: "demo",
        nonInteractive: true,
      });
      await expect(
        initConfig({
          collabRoot,
          cwd: dir,
          output: ".env.local",
          profile: "demo",
          nonInteractive: true,
        }),
      ).rejects.toThrow(/refusing to overwrite/);
      const again = await initConfig({
        collabRoot,
        cwd: dir,
        output: ".env.local",
        profile: "postgres",
        force: true,
        nonInteractive: true,
      });
      const body = await readFile(again.outputPath, "utf8");
      expect(body).toContain("COLLAB_DATABASE_URL=");
      expect(body).toContain("replace-from-secret-store");
      expect(again.overwritten).toBe(true);
      await expect(
        initConfig({
          collabRoot,
          cwd: dir,
          output: ".env.local",
          profile: "demo",
          nonInteractive: false,
          confirmOverwrite: async () => false,
        }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps ldap deployment placeholders on encrypted transport", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-init-"));
    try {
      const result = await initConfig({
        collabRoot,
        cwd: dir,
        output: "deploy.env",
        profile: "ldap",
        nonInteractive: true,
      });
      const body = await readFile(result.outputPath, "utf8");
      expect(body).toContain("COLLAB_LDAP_URL=ldaps://");
      expect(body).toContain("COLLAB_COOKIE_SECURE=1");
      expect(body).not.toContain("COLLAB_LDAP_URL=ldap://directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("env file parser", () => {
  it("does not include secret line text in malformed errors", () => {
    const secret = "leak-me-now";
    expect(() => parseEnvFile(`COLLAB_LDAP_BIND_PASSWORD${secret}`)).toThrow(/line 1 is malformed/);
    try {
      parseEnvFile(`COLLAB_LDAP_BIND_PASSWORD${secret}`);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("doctor compile-first scripts", () => {
  it("does not depend on tsx for doctor or config:init", async () => {
    const pkg = JSON.parse(await readFile(join(collabRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const serverPkg = JSON.parse(
      await readFile(join(collabRoot, "server/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.doctor).toMatch(/node server\/dist\/doctor-cli\.js/);
    expect(pkg.scripts["config:init"]).toMatch(/node server\/dist\/config-init-cli\.js/);
    expect(serverPkg.scripts.doctor).toBe("node dist/doctor-cli.js");
    expect(serverPkg.scripts["config:init"]).toBe("node dist/config-init-cli.js");
    expect(pkg.scripts.doctor).not.toMatch(/tsx/);
    expect(pkg.scripts["config:init"]).not.toMatch(/tsx/);
  });
});

describe("real filesystem evidence probe", () => {
  it("detects an unwritable evidence directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-ev-"));
    const evidence = join(dir, "evidence");
    await mkdir(evidence);
    await chmod(evidence, 0o500);
    try {
      expect(nodeOperatorFs.isWritableDirectory(evidence)).toBe(false);
    } finally {
      await chmod(evidence, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
