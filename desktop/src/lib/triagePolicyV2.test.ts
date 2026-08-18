import { describe, expect, it, vi } from "vitest";
import type { TriageService } from "@contextdesk/client";
import {
  TRIAGE_POLICY_MODES,
  buildTriageRequestV2,
  resolveSelectedTriageModel,
  runTriageSelection,
} from "./triagePolicyV2";

const base = {
  task: "Find the initiating cause.",
  corpusId: "corpus:incident:42",
  profileId: "gateway:primary",
  modelId: "model:triage:exact",
  runId: "run:desktop:42",
  cancellationId: "cancel:desktop:42",
} as const;

describe("Triage Policy V2 desktop selection", () => {
  it("represents Standard, Enhanced, and Advanced with only Standard available", () => {
    expect(TRIAGE_POLICY_MODES).toEqual([
      { value: "standard", label: "Standard", available: true },
      { value: "enhanced", label: "Enhanced", available: false },
      { value: "advanced", label: "Advanced", available: false },
    ]);
  });

  it("maps Standard exactly to the selected gateway-scoped model", () => {
    expect(buildTriageRequestV2({ mode: "standard", ...base })).toEqual({
      schema_id: "contextdesk.triage.request.v2",
      run_id: "run:desktop:42",
      privacy: "owner_only",
      task: "Find the initiating cause.",
      scope: {
        corpus_id: "corpus:incident:42",
      },
      policy: {
        kind: "standard",
        model: {
          profile_id: "gateway:primary",
          model_id: "model:triage:exact",
        },
      },
      overrides: {},
      cancellation_id: "cancel:desktop:42",
    });
  });

  it("resolves a selected model by exact provider identity, never a bare model fallback", () => {
    expect(
      resolveSelectedTriageModel({
        sessionModel: null,
        sessionProvider: null,
        modelOptions: [
          {
            id: "same-model",
            label: "Same model",
            selection_key: "gateway-b::same-model",
            provider_id: "gateway-b",
            provider_label: "Gateway B",
            group: "Gateway B",
            is_default: true,
            tools_enabled: true,
            tools_disabled_reason: null,
            availability: "discovered",
            availability_detail: null,
            hidden: false,
            hidden_by: null,
            pinned_rank: null,
          },
        ],
        defaultModelKey: "gateway-b::same-model",
      }),
    ).toEqual({ profileId: "gateway-b", modelId: "same-model" });

    expect(
      resolveSelectedTriageModel({
        sessionModel: "same-model",
        sessionProvider: null,
        modelOptions: [],
        defaultModelKey: "same-model",
      }),
    ).toBeNull();
  });

  it.each(["enhanced", "advanced"] as const)(
    "fails closed for configured %s before provider execution",
    (mode) => {
      const run = vi.fn();
      const service = { run } as unknown as TriageService;

      expect(() => runTriageSelection(service, { mode, ...base })).toThrow(
        new RegExp(`${mode} is unavailable`, "i"),
      );
      expect(run).not.toHaveBeenCalled();
    },
  );
});
