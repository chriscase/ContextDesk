import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfiguredTriageProfileCatalog, parseTriageProfileCatalog } from "./profiles.js";

describe("triage profile catalog", () => {
  it("keeps only bounded non-secret profile metadata and deduplicates ids", () => {
    expect(
      parseTriageProfileCatalog(
        JSON.stringify([
          { id: "profile:employer", label: "Employer gateway", provider: "openai-compatible", apiKey: "secret" },
          { id: "profile:employer", label: "duplicate", provider: "openai-compatible" },
          { id: "", label: "invalid", provider: "openai-compatible" },
        ]),
      ),
    ).toEqual([{ id: "profile:employer", label: "Employer gateway", provider: "openai-compatible" }]);
  });

  it("fails closed for malformed configuration", () => {
    expect(parseTriageProfileCatalog("not-json")).toEqual([]);
    expect(parseTriageProfileCatalog(JSON.stringify({ id: "profile:one" }))).toEqual([]);
  });

  it("loads the strict live catalog for the production GUI/bridge seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-profile-catalog-"));
    const path = join(root, "live.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          schemaId: "cd-collab.live_qualification_catalog.v1",
          privacyClass: "share_safe",
          profiles: [
            {
              alias: "qwen-3.6-27b",
              profileId: "employer-qwen-3.6-27b",
              modelId: "qwen-3.6-27b",
              provider: "employer-gateway",
              label: "Employer Qwen",
            },
          ],
        }),
        "utf8",
      );
      expect(loadConfiguredTriageProfileCatalog({ COLLAB_LIVE_PROFILE_CATALOG: path })).toEqual([
        {
          id: expect.stringMatching(/^subject:[a-f0-9]{64}$/),
          profileId: "employer-qwen-3.6-27b",
          modelId: "qwen-3.6-27b",
          alias: "qwen-3.6-27b",
          label: "Employer Qwen",
          provider: "employer-gateway",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps models on one host profile as distinct selectable subjects", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-profile-catalog-"));
    const path = join(root, "live.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          schemaId: "cd-collab.live_qualification_catalog.v1",
          privacyClass: "share_safe",
          profiles: [
            {
              alias: "qwen-3.6-27b",
              profileId: "shared-gateway",
              modelId: "provider/qwen-3.6-27b",
              provider: "openai-compatible-gateway",
              label: "Model A",
            },
            {
              alias: "gpt-oss-120b",
              profileId: "shared-gateway",
              modelId: "provider/gpt-oss-120b",
              provider: "openai-compatible-gateway",
              label: "Model B",
            },
          ],
        }),
        "utf8",
      );
      const profiles = loadConfiguredTriageProfileCatalog({ COLLAB_LIVE_PROFILE_CATALOG: path });
      expect(profiles.map((profile) => profile.label)).toEqual(["Model A", "Model B"]);
      expect(new Set(profiles.map((profile) => profile.id)).size).toBe(2);
      expect(profiles.map((profile) => profile.profileId)).toEqual([
        "shared-gateway",
        "shared-gateway",
      ]);
      expect(profiles.map((profile) => profile.modelId)).toEqual([
        "provider/qwen-3.6-27b",
        "provider/gpt-oss-120b",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
