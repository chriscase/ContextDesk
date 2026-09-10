import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./provider-identity-cli.ts", import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PIN = "8d2f63fa-327e-4b90-9d43-aa4f10e1d3a2";
const WRONG_PIN = "267ad846-b2e0-4af0-8d87-4d788e48c155";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider identity executable", () => {
  it("keeps stdout and stderr machine-readable across inspect, init, and mismatch", async () => {
    const root = await temporaryRoot();
    const evidenceRoot = join(root, "evidence-canary");
    const legacyFile = join(root, "legacy.env");
    const pinnedFile = join(root, "pinned.env");
    const wrongFile = join(root, "wrong.env");
    await writeFile(legacyFile, filesystemEnv(evidenceRoot), "utf8");
    await writeFile(pinnedFile, filesystemEnv(evidenceRoot, PIN), "utf8");
    await writeFile(wrongFile, filesystemEnv(evidenceRoot, WRONG_PIN), "utf8");

    expectSuccess(run(["inspect", "--env-file", legacyFile]), "legacy_unbound");
    expectSuccess(run(["inspect", "--env-file", pinnedFile]), "uninitialized");
    expectSuccess(run(["init", "--env-file", pinnedFile, "--yes"]), "created");
    expectSuccess(run(["inspect", "--env-file", pinnedFile]), "matching");
    expectSuccess(run(["init", "--env-file", pinnedFile, "--yes"]), "existing");

    const mismatch = run(["inspect", "--env-file", wrongFile]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toBe("");
    expect(JSON.parse(mismatch.stderr)).toMatchObject({
      ok: false,
      code: "identity_mismatch",
    });
    for (const canary of [PIN, WRONG_PIN, evidenceRoot]) {
      expect(`${mismatch.stdout}${mismatch.stderr}`).not.toContain(canary);
    }
  });

  it("fails closed on arguments and unreadable or malformed environment files", async () => {
    const root = await temporaryRoot();
    const malformed = join(root, "malformed-canary.env");
    const missing = join(root, "missing-canary.env");
    await writeFile(malformed, "not an environment line containing secret-canary", "utf8");

    expectFailure(run(["init", "--env-file", malformed]), "confirmation_required");
    const malformedFailure = run(["inspect", "--env-file", malformed]);
    expectFailure(malformedFailure, "invalid_configuration");
    expect(`${malformedFailure.stdout}${malformedFailure.stderr}`).not.toContain(malformed);
    expect(`${malformedFailure.stdout}${malformedFailure.stderr}`).not.toContain("secret-canary");
    expectFailure(run(["inspect", "--env-file", missing]), "invalid_configuration");
    expectFailure(run(["inspect", "--env-file", malformed, "--unknown"]), "invalid_arguments");
    const failure = run(["inspect", "--env-file", missing]);
    for (const value of [missing]) {
      expect(failure.stderr).not.toContain(value);
    }
  });

  it("keeps the documented workspace command wired to the built executable", async () => {
    const server = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const workspace = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(server.scripts["evidence:identity"]).toBe("node -- dist/provider-identity-cli.js");
    expect(workspace.scripts["evidence:identity"]).toContain(
      "npm run evidence:identity -w @cd-collab/server --",
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cd-provider-identity-cli-"));
  roots.push(root);
  return root;
}

function filesystemEnv(root: string, pin?: string): string {
  return [
    "COLLAB_STORAGE=sqlite",
    "COLLAB_EVIDENCE_PROVIDER=filesystem",
    `COLLAB_EVIDENCE_ROOT=${root}`,
    ...(pin ? [`COLLAB_EVIDENCE_PROVIDER_INSTANCE_ID=${pin}`] : []),
    "",
  ].join("\n");
}

function run(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", "--", CLI, ...args], {
    cwd: SERVER_ROOT,
    env: cleanEnvironment(),
    encoding: "utf8",
  });
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && !key.startsWith("COLLAB_") && !key.startsWith("AWS_")),
  );
}

function expectSuccess(
  completed: ReturnType<typeof spawnSync>,
  status: string,
): void {
  expect(completed.status).toBe(0);
  expect(completed.stderr).toBe("");
  expect(JSON.parse(completed.stdout)).toMatchObject({
    schemaId: "cd-collab.evidence_provider_identity_operator.v1",
    status,
  });
}

function expectFailure(
  completed: ReturnType<typeof spawnSync>,
  code: string,
): void {
  expect(completed.status).toBe(1);
  expect(completed.stdout).toBe("");
  expect(JSON.parse(completed.stderr)).toMatchObject({
    schemaId: "cd-collab.evidence_provider_identity_operator.v1",
    ok: false,
    code,
  });
}
