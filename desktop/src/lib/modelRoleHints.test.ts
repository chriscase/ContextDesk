/**
 * Pure model-role hint catalog tests (#723).
 * Drives the shipped `classifyModelRole` / `sortIdsForChatPicker` entry points.
 */
import { describe, expect, it } from "vitest";
import goldenCatalog from "../../../fixtures/providers/model-role-hints.v1.json";
import {
  MODEL_ROLE_HINT_CATALOG_VERSION,
  classifyModelRole,
  describeRecommendationBasis,
  excludeHiddenModelIds,
  formatRoleHintAccessible,
  initialChatPickerSelection,
  preferredChatDefaultId,
  sortIdsForChatPicker,
} from "./modelRoleHints";

describe("modelRoleHints (#723)", () => {
  it("matches the same checked-in golden catalog as Rust", () => {
    expect(goldenCatalog.catalog_version).toBe(
      MODEL_ROLE_HINT_CATALOG_VERSION,
    );
    for (const expected of goldenCatalog.cases) {
      const actual = classifyModelRole(expected.id);
      expect(actual.catalogVersion, expected.id).toBe(
        goldenCatalog.catalog_version,
      );
      expect(actual.role, expected.id).toBe(expected.role);
      expect(actual.confidence, expected.id).toBe(expected.confidence);
      expect(actual.source, expected.id).toBe(expected.source);
      expect(actual.ordinaryChatDefault, expected.id).toBe(
        expected.ordinary_chat_default,
      );
    }
  });

  it("uses a stable catalog version", () => {
    expect(classifyModelRole("grok-3").catalogVersion).toBe(
      MODEL_ROLE_HINT_CATALOG_VERSION,
    );
  });

  it("classifies familiar investigator families", () => {
    for (const id of [
      "grok-3",
      "gpt-4o-mini",
      "claude-sonnet-4-20250514",
      "mistral",
      "llama-3.1-8b-instruct",
    ]) {
      const s = classifyModelRole(id);
      expect(s.role, id).toBe("investigator");
      expect(s.ordinaryChatDefault, id).toBe(true);
      expect(s.source).toBe("name_hint");
      expect(s.basisLabel).toBe("Name hint");
      expect(s.suggestedFor).toMatch(/Suggested for/);
    }
  });

  it("classifies embedding names and refuses ordinary chat default ranking", () => {
    for (const id of [
      "bge-m3",
      "nomic-embed-text",
      "text-embedding-3-small",
      "voyage-3",
    ]) {
      const s = classifyModelRole(id);
      expect(s.role, id).toBe("embedding");
      expect(s.ordinaryChatDefault, id).toBe(false);
      expect(s.suggestedFor).toMatch(/embedding/);
    }
  });

  it("classifies reranker names", () => {
    for (const id of [
      "qwen3-reranker-0.6b",
      "bge-reranker-v2-m3",
      "cross-encoder-ms-marco",
    ]) {
      const s = classifyModelRole(id);
      expect(s.role, id).toBe("reranker");
      expect(s.ordinaryChatDefault, id).toBe(false);
    }
  });

  it("keeps private aliases unknown and selectable", () => {
    for (const id of ["corp-prod-v3", "team-a-router", "internal-deploy-42"]) {
      const s = classifyModelRole(id);
      expect(s.role, id).toBe("unknown");
      expect(s.confidence, id).toBe("low");
      expect(s.ordinaryChatDefault, id).toBe(false);
      const sorted = sortIdsForChatPicker([id, "grok-3"]);
      expect(sorted).toContain(id);
    }
  });

  it("handles deceptive keyword names honestly", () => {
    const embedish = classifyModelRole("chat-bge-m3-embed");
    expect(embedish.role).toBe("embedding");
    expect(embedish.ordinaryChatDefault).toBe(false);

    const rerankish = classifyModelRole("gpt-oss-reranker-v1");
    expect(rerankish.role).toBe("reranker");
    expect(rerankish.ordinaryChatDefault).toBe(false);
  });

  it("sorts mixed-role inventories without dropping ids", () => {
    const ids = [
      "bge-m3",
      "qwen3-reranker-0.6b",
      "corp-alias",
      "grok-3",
      "nomic-embed-text",
    ];
    const sorted = sortIdsForChatPicker(ids);
    expect(sorted.indexOf("grok-3")).toBeLessThan(sorted.indexOf("bge-m3"));
    expect(sorted.indexOf("grok-3")).toBeLessThan(
      sorted.indexOf("qwen3-reranker-0.6b"),
    );
    expect(sorted).toHaveLength(ids.length);
    expect(sorted).toContain("corp-alias");
  });

  it("does not invent a default change — pure functions only", () => {
    const a = classifyModelRole("user-chosen-private-id");
    const b = classifyModelRole("user-chosen-private-id");
    expect(a).toEqual(b);
    expect(a.ordinaryChatDefault).toBe(false);
  });

  it("excludes hidden model ids without expanding inventory (#678)", () => {
    const visible = excludeHiddenModelIds(
      ["grok-3", "secret-corp-alias", "bge-m3"],
      new Set(["secret-corp-alias"]),
    );
    expect(visible).toEqual(["grok-3", "bge-m3"]);
    // Classification of a single id never requires the full inventory.
    expect(classifyModelRole("secret-corp-alias").role).toBe("unknown");
  });

  it("exposes accessible labels with basis and non-capability disclaimer", () => {
    const s = classifyModelRole("bge-m3");
    const a11y = formatRoleHintAccessible(s);
    expect(a11y).toMatch(/Name hint/);
    expect(a11y).toMatch(/Not measured capability/);
    expect(describeRecommendationBasis(["name_hint", "user_override"])).toBe(
      "Name hint · User override",
    );
  });

  it("preferredChatDefaultId never returns embed/rerank and nulls specialty-only", () => {
    expect(preferredChatDefaultId(["bge-m3", "grok-3", "qwen3-reranker-0.6b"])).toBe(
      "grok-3",
    );
    expect(
      preferredChatDefaultId(["bge-m3", "qwen3-reranker-0.6b", "nomic-embed-text"]),
    ).toBeNull();
    expect(preferredChatDefaultId([])).toBeNull();
  });

  it("initialChatPickerSelection keeps specialty/unknown inventories confirmable", () => {
    // Prefer ordinary chat when present.
    expect(
      initialChatPickerSelection(["bge-m3", "grok-3", "qwen3-reranker-0.6b"]),
    ).toBe("grok-3");
    // Specialty-only: still return first listed so Apply can bind a real id.
    expect(initialChatPickerSelection(["bge-m3"])).toBe("bge-m3");
    expect(
      initialChatPickerSelection(["qwen3-reranker-0.6b", "bge-m3"]),
    ).toBe("qwen3-reranker-0.6b");
    // Unknown-only private alias remains selectable/confirmable.
    expect(initialChatPickerSelection(["corp-private-alias"])).toBe(
      "corp-private-alias",
    );
    expect(initialChatPickerSelection([])).toBe("");
  });

  it("sort keeps specialty ids selectable (listed last)", () => {
    const sorted = sortIdsForChatPicker([
      "bge-m3",
      "grok-3",
      "qwen3-reranker-0.6b",
    ]);
    expect(sorted).toContain("bge-m3");
    expect(sorted).toContain("qwen3-reranker-0.6b");
    expect(sorted[0]).toBe("grok-3");
  });
});
