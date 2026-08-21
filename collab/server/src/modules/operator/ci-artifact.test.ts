import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertReleaseArtifactSafe, sanitizeCiArtifacts } from "./ci-artifact.js";
import { initConfig } from "./config-init.js";
import { runDoctor } from "./doctor.js";
import type { OperatorFs } from "./fs.js";

const here = dirname(fileURLToPath(import.meta.url));
const collabRoot = join(here, "../../../..");
const fixtures = join(collabRoot, "contracts/fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
}

function memoryFs(entries: Record<string, "file" | "dir">): OperatorFs {
  return {
    exists: (path) => path in entries,
    isFile: (path) => entries[path] === "file",
    isDirectory: (path) => entries[path] === "dir",
    isWritableDirectory: (path) => entries[path] === "dir",
    readFile: () => {
      throw new Error("missing file");
    },
  };
}

describe("release artifact redaction", () => {
  it("accepts the valid qualification and doctor fixtures", () => {
    expect(() =>
      assertReleaseArtifactSafe({ reports: [load("qualification-report.valid.json")] }),
    ).not.toThrow();
    expect(() => assertReleaseArtifactSafe(load("doctor-report.valid.json"))).not.toThrow();
  });

  it("rejects prompts, credentials, endpoints, request ids, paths, and hostnames", () => {
    const secret = "supersecret-ci-token";
    const cases: unknown[] = [
      { ...(load("doctor-report.valid.json") as object), prompt: "system override" },
      { ...(load("doctor-report.valid.json") as object), rawCapture: "model dump" },
      { ...(load("doctor-report.valid.json") as object), api_key: secret },
      { ...(load("doctor-report.valid.json") as object), endpoint: "https://gateway.example.test/v1" },
      { ...(load("doctor-report.valid.json") as object), request_id: "req-abc123xyz" },
    ];
    for (const poisoned of cases) {
      expect(() => assertReleaseArtifactSafe(poisoned)).toThrow(/release artifact rejected/);
      try {
        assertReleaseArtifactSafe(poisoned);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain("system override");
        expect(String(error)).not.toContain("model dump");
      }
    }
  });

  it("rejects a qualification report that fabricates a live run", () => {
    const raw = load("qualification-report.valid.json") as {
      liveProfiles: Array<{
        alias: string;
        configured: boolean;
        ran: boolean;
        skippedReason: string | null;
      }>;
    };
    raw.liveProfiles[0] = {
      alias: "gpt-oss-120b",
      configured: true,
      ran: true,
      skippedReason: null,
    };
    expect(() => assertReleaseArtifactSafe({ reports: [raw] })).toThrow();
  });

  it("writes only sanitized copies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-artifact-"));
    try {
      const source = join(dir, "raw");
      const dest = join(dir, "sanitized");
      await mkdir(source);
      await writeFile(
        join(source, "doctor.json"),
        JSON.stringify(load("doctor-report.valid.json")),
      );
      const written = await sanitizeCiArtifacts({ sourceDir: source, destDir: dest });
      expect(written).toHaveLength(1);
      const body = await readFile(written[0] ?? "", "utf8");
      expect(JSON.parse(body).schemaId).toBe("cd-collab.doctor_report.v1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("doctor/config-init smoke for hosted CI", () => {
  it("produces an artifact-safe doctor report after config:init", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-ci-smoke-"));
    try {
      const result = await initConfig({
        collabRoot,
        cwd: dir,
        output: ".env.local",
        profile: "demo",
        nonInteractive: true,
      });
      const evidence = result.createdDirectories[0] ?? "";
      const fixtureRoot = "/fixture-collab";
      const report = runDoctor({
        env: {
          COLLAB_AUTH_MODE: "demo",
          COLLAB_COOKIE_SECURE: "0",
          COLLAB_EVIDENCE_ROOT: evidence,
          COLLAB_PORT: "8787",
        },
        collabRoot: fixtureRoot,
        cwd: fixtureRoot,
        nodeVersion: process.versions.node,
        fs: memoryFs({
          [`${fixtureRoot}/contracts/dist/index.js`]: "file",
          [`${fixtureRoot}/server/dist/index.js`]: "file",
          [`${fixtureRoot}/web/dist/index.html`]: "file",
          [`${fixtureRoot}/web/dist`]: "dir",
          [evidence]: "dir",
        }),
      });
      expect(report.ok).toBe(true);
      expect(() => assertReleaseArtifactSafe(report)).not.toThrow();
      expect(JSON.stringify(report)).not.toMatch(/postgres:\/\//);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
