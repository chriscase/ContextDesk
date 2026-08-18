import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { TriageRunEventV2, TriageRequestV2 } from "@contextdesk/contracts";
import type {
  TriageRunOptions,
  TriageService,
} from "@contextdesk/client";
import type { AppSetupState } from "../lib/preflight";
import { newSession, type ChatSession } from "../lib/session";
import { useTurnController } from "./useTurnController";

const host = vi.hoisted(() => ({
  agentTurn: vi.fn(),
  completePermission: vi.fn(),
  hostCancelTurn: vi.fn(),
  hostReadFile: vi.fn(),
}));

vi.mock("../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/host")>();
  return {
    ...original,
    agentTurn: host.agentTurn,
    completePermission: host.completePermission,
    hostCancelTurn: host.hostCancelTurn,
    hostReadFile: host.hostReadFile,
  };
});

const setup: AppSetupState = {
  dataDirWritable: true,
  workspaceName: "Test",
  workspaceRoots: ["/workspace"],
  providerLabel: "Gateway",
  providerKind: "openai_compatible",
  chatModel: "triage-model",
  baseUrl: "https://example.invalid/v1",
  hasApiKey: true,
  ollamaReachable: null,
  remoteReachable: true,
  confluence: { enabled: false, baseUrl: "", spaces: "", hasToken: false },
};

function terminal(kind: "completed" | "cancelled" = "completed"): TriageRunEventV2 {
  const partial = {
    schema_id: "contextdesk.triage.result.v2",
    run_id: "dynamic-run",
    kind: "honest_partial",
    validation_state: "partial",
    packet_id: "packet:desktop",
    reconciliation: {
      state: "insufficient_evidence",
      configured_role_slots: 1,
      completed_role_slots: 1,
      distinct_models: 1,
      distinct_gateways: 1,
      root_cause_established: false,
    },
    reason_codes: ["insufficient_evidence"],
  };
  return {
    schema_id: "contextdesk.triage.run_event.v2",
    run_id: "dynamic-run",
    sequence: 1,
    privacy: "owner_only",
    event:
      kind === "completed"
        ? { kind, result: partial }
        : {
            kind,
            cancellation_id: "dynamic-cancel",
            partial_result: partial,
          },
  } as TriageRunEventV2;
}

function serviceWith(run: TriageService["run"]): TriageService {
  return {
    capability: { supported: true, replay: true },
    preflight: vi.fn(),
    qualify: vi.fn(),
    run,
    replay: vi.fn(),
    cancel: vi.fn(),
    onRunEvent: vi.fn(() => () => {}),
  };
}

function mount(run: TriageService["run"]) {
  const initial: ChatSession = {
    ...newSession("Triage"),
    chatModel: "triage-model",
    providerProfileId: "gateway-profile",
    linkedCorpusId: "corpus:desktop",
  };
  let sessions: ChatSession[] = [initial];
  const setSessions: Dispatch<SetStateAction<ChatSession[]>> = (update) => {
    sessions = typeof update === "function" ? update(sessions) : update;
  };
  const triageService = serviceWith(run);
  const rendered = renderHook(() =>
    useTurnController({
      sessionId: initial.id,
      resolvedSessionId: initial.id,
      sessions,
      setSessions,
      ensureActiveSession: () => initial,
      setup,
      modelOptions: [
        {
          id: "triage-model",
          label: "Triage model",
          selection_key: "gateway-profile::triage-model",
          provider_id: "gateway-profile",
          provider_label: "Gateway",
          group: "Gateway",
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
      defaultModelKey: "gateway-profile::triage-model",
      preflightBlocking: false,
      onNeedPreflight: vi.fn(),
      persistSession: vi.fn(async (session) => session),
      upgradeTitleWithLlm: vi.fn(async () => undefined),
      pinScrollToEnd: vi.fn(),
      refreshMemory: vi.fn(async () => undefined),
      refreshChatModels: vi.fn(async () => undefined),
      setSourcePath: vi.fn(),
      setSourceContent: vi.fn(),
      setPaneChat: vi.fn(),
      triageService,
    }),
  );
  return {
    rendered,
    get sessions() {
      return sessions;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  host.hostCancelTurn.mockResolvedValue(undefined);
  host.completePermission.mockResolvedValue([]);
});

describe("useTurnController Triage Policy V2 path", () => {
  it("runs Standard through the triage service with the exact selected identity", async () => {
    const done = terminal();
    const run = vi.fn(
      async (request: TriageRequestV2, options?: TriageRunOptions) => {
        const event = { ...done, run_id: request.run_id };
        options?.onEvent?.(event);
        return event;
      },
    );
    const harness = mount(run);

    await act(async () => {
      await harness.rendered.result.current.startTurn("Investigate this.", undefined, {
        mode: "standard",
        corpusId: "corpus:desktop",
      });
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      task: "Investigate this.",
      scope: { corpus_id: "corpus:desktop" },
      policy: {
        kind: "standard",
        model: {
          profile_id: "gateway-profile",
          model_id: "triage-model",
        },
      },
    });
    expect(host.agentTurn).not.toHaveBeenCalled();
    expect(
      harness.sessions
        .flatMap((session) => session.messages)
        .find((message) => message.role === "assistant"),
    ).toMatchObject({ streaming: false });
  });

  it.each(["enhanced", "advanced"] as const)(
    "rejects %s before either provider path starts",
    async (mode) => {
      const run = vi.fn();
      const harness = mount(run as TriageService["run"]);

      let accepted = true;
      await act(async () => {
        accepted = await harness.rendered.result.current.startTurn(
          "Do not run.",
          undefined,
          { mode, corpusId: "corpus:desktop" },
        );
      });

      expect(accepted).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(host.agentTurn).not.toHaveBeenCalled();
      expect(harness.sessions[0]?.messages).toHaveLength(0);
    },
  );

  it("routes Stop to the triage abort signal and not the ordinary turn cancel", async () => {
    let observedSignal: AbortSignal | undefined;
    let finish!: () => void;
    const run = vi.fn(
      (_request: TriageRequestV2, options?: TriageRunOptions) =>
        new Promise<TriageRunEventV2>((resolve) => {
          observedSignal = options?.signal;
          finish = () => resolve(terminal("cancelled"));
        }),
    );
    const harness = mount(run);
    let pending!: Promise<boolean>;

    await act(async () => {
      pending = harness.rendered.result.current.startTurn("Investigate.", undefined, {
        mode: "standard",
        corpusId: "corpus:desktop",
      });
    });
    expect(run).toHaveBeenCalledTimes(1);

    act(() => harness.rendered.result.current.stopTurn());

    expect(observedSignal?.aborted).toBe(true);
    expect(host.hostCancelTurn).not.toHaveBeenCalled();
    expect(
      harness.sessions.some((session) =>
        session.messages.some((message) => message.streaming),
      ),
    ).toBe(false);

    finish();
    await act(async () => {
      await pending;
    });
  });
});
