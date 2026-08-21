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
        { id: "employer-qwen-3.6-27b", label: "Employer Qwen", provider: "employer-gateway" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
