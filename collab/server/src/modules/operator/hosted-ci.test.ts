import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectLiveProfiles } from "../qualification/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../../../");
const workflow = readFileSync(join(repoRoot, ".github/workflows/collab-qualify.yml"), "utf8");

describe("hosted collab-qualify workflow", () => {
  it("runs Node 22, npm ci, typecheck, lint, tests, build, memory and postgres qualify, doctor", () => {
    expect(workflow).toMatch(/node-version:\s*"22"/);
    expect(workflow).toMatch(/npm ci/);
    expect(workflow).toMatch(/npm run typecheck/);
    expect(workflow).toMatch(/npm run lint/);
    expect(workflow).toMatch(/npm test/);
    expect(workflow).toMatch(/npm run build/);
    expect(workflow).toMatch(/--backend memory/);
    expect(workflow).toMatch(/--backend postgres/);
    expect(workflow).toMatch(/config:init/);
    expect(workflow).toMatch(/doctor-cli\.js --json/);
    expect(workflow).toMatch(/image: postgres:16/);
    expect(workflow).toMatch(/COLLAB_TEST_ADMIN_URL:/);
    expect(workflow).toMatch(/upload-artifact@v4/);
    expect(workflow).toMatch(/collab\/\.ci-qualify\/sanitized\//);
  });

  it("does not contact LDAP, Vercel, or live model hosts", () => {
    expect(workflow).not.toMatch(/osixia\/openldap/);
    expect(workflow).not.toMatch(/COLLAB_LDAP_URL:/);
    expect(workflow).not.toMatch(/COLLAB_LDAP_BIND_PASSWORD:/);
    expect(workflow).not.toMatch(/COLLAB_LIVE_PROFILES:/);
    expect(workflow).not.toMatch(/ai-gateway/);
    expect(workflow).toMatch(/COLLAB_LIVE_VERCEL:\s*"0"/);
    expect(workflow).toMatch(/contents:\s*read/);
  });
});

describe("live profiles remain skipped by default", () => {
  it("marks every alias skipped without live env", () => {
    const profiles = inspectLiveProfiles({});
    expect(profiles).toHaveLength(4);
    expect(profiles.every((profile) => !profile.configured)).toBe(true);
    expect(profiles.every((profile) => !profile.ran)).toBe(true);
    expect(
      profiles.every((profile) => profile.skippedReason === "credentials_not_configured"),
    ).toBe(true);
  });

  it("does not treat COLLAB_LIVE_VERCEL=0 as a live run", () => {
    const profiles = inspectLiveProfiles({ COLLAB_LIVE_VERCEL: "0" });
    expect(profiles.every((profile) => !profile.ran)).toBe(true);
    expect(profiles.find((profile) => profile.alias === "vercel-compatible")?.configured).toBe(
      false,
    );
  });
});
