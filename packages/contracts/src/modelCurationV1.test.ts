import { describe, expect, it } from "vitest";
import {
  modelSelectionKey,
  parseCurationImpact,
  parseModelOptions,
  parseModelSelectionKey,
} from "./modelCurationV1";

describe("governed curation identity", () => {
  it("cannot collide when provider and model ids contain the old separator", () => {
    const left = modelSelectionKey("a", "b::c");
    const right = modelSelectionKey("a::b", "c");
    expect(left).not.toBe(right);
    expect(parseModelSelectionKey(left)).toEqual({
      providerId: "a",
      modelId: "b::c",
    });
    expect(parseModelSelectionKey(right)).toEqual({
      providerId: "a::b",
      modelId: "c",
    });
  });

  it("counts UTF-8 bytes exactly like the Rust encoder", () => {
    const key = modelSelectionKey("équipe", "模型::β");
    expect(parseModelSelectionKey(key)).toEqual({
      providerId: "équipe",
      modelId: "模型::β",
    });
  });

  it("reads legacy and bare-model values without writing them", () => {
    expect(parseModelSelectionKey("legacy::model::tag")).toEqual({
      providerId: "legacy",
      modelId: "model::tag",
    });
    expect(parseModelSelectionKey("mistral")).toEqual({
      providerId: null,
      modelId: "mistral",
    });
    expect(modelSelectionKey("legacy", "model::tag")).toMatch(
      /^cd\.model\.v1:/,
    );
  });

  it("fails malformed versioned values closed instead of treating them as a model id", () => {
    expect(parseModelSelectionKey("cd.model.v1:99:short")).toEqual({
      providerId: null,
      modelId: "",
    });
  });
});

describe("curation wire validation", () => {
  it("rejects an option whose structured fields disagree with its key", () => {
    expect(() =>
      parseModelOptions([
        {
          id: "wrong",
          label: "wrong",
          selection_key: modelSelectionKey("p", "right"),
          provider_id: "p",
          provider_label: "P",
          group: "P",
          is_default: false,
          tools_enabled: true,
          tools_disabled_reason: null,
          availability: "discovered",
          availability_detail: null,
          hidden: false,
          hidden_by: null,
          pinned_rank: null,
        },
      ]),
    ).toThrow(/identity does not match/);
  });

  it("requires the drift-detection token", () => {
    expect(() =>
      parseCurationImpact({
        affects_default: true,
        replacement_key: null,
        replacement_label: null,
        remaining_visible: 1,
      }),
    ).toThrow(/state_token/);
  });
});
