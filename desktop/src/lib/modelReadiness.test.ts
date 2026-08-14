import { describe, expect, it } from "vitest";
import type { ModelOptionDto } from "@contextdesk/contracts";
import {
  isVerifiedChatModel,
  modelReadinessLabel,
} from "./modelReadiness";

function model(overrides: Partial<ModelOptionDto> = {}): ModelOptionDto {
  return {
    id: "deepseek-v4-flash",
    label: "deepseek-v4-flash",
    selection_key: "employer::deepseek-v4-flash",
    provider_id: "employer",
    provider_label: "Employer Gateway",
    group: "Employer Gateway",
    is_default: false,
    tools_enabled: true,
    tools_disabled_reason: null,
    availability: "discovered",
    availability_detail: null,
    hidden: false,
    hidden_by: null,
    pinned_rank: null,
    ...overrides,
  };
}

describe("model readiness labels", () => {
  it("does not turn an absent or name-only result into verification", () => {
    expect(modelReadinessLabel(model())).toBe("not verified");
    expect(isVerifiedChatModel(model())).toBe(false);
  });

  it("marks only current measured chat evidence as verified for chat", () => {
    const verified = model({
      readiness: {
        role: "chat",
        state: "verified",
        basis: "measured",
        tested_at: 100,
        detail: "Synthetic contracts passed.",
      },
    });
    expect(modelReadinessLabel(verified)).toBe("verified for triage");
    expect(isVerifiedChatModel(verified)).toBe(true);
  });

  it("keeps specialty verification role-specific", () => {
    const embedding = model({
      readiness: {
        role: "embedding",
        state: "verified",
        basis: "measured",
        tested_at: 100,
        detail: "Embedding contract passed.",
      },
    });
    expect(modelReadinessLabel(embedding)).toBe("verified for embeddings");
    expect(isVerifiedChatModel(embedding)).toBe(false);
  });
});
