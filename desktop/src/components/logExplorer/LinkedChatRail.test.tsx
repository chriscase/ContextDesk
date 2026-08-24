/**
 * Linked chat rail: follow-latest (#529), compact multi-chat (#543), tool UI (#530).
 * Tests use the real rendered rail — not source-string or helper-only assertions.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../../lib/host";
import * as turnActivity from "../../lib/engine/turnActivity";
import {
  saveActivityMode,
  saveDeveloperActivityDetail,
} from "../../lib/activity/prefs";
import { publishTurnActivityUpdate } from "../../lib/activity/turnActivityUpdateBridge";
import {
  hasHostLinkedSynthesisRetry,
  LinkedChatRail,
  shouldApplyChatLoad,
  type AgentContextSummary,
} from "./LinkedChatRail";

it("requires an exact host-authored retry availability event", () => {
  const timeoutOnly: host.EventDto[] = [
    {
      kind: "error",
      payload: { code: "linked_synthesis_timeout", message: "timed out" },
    },
  ];
  expect(
    hasHostLinkedSynthesisRetry(
      timeoutOnly,
      "chat",
      "corpus",
      "provider",
      "model",
    ),
  ).toBe(false);
  expect(
    hasHostLinkedSynthesisRetry(
      [
        ...timeoutOnly,
        {
          kind: "linked_synthesis_retry",
          payload: {
            available: true,
            session_id: "chat",
            corpus_id: "corpus",
            provider_profile_id: "provider",
            model_id: "model",
          },
        },
      ],
      "chat",
      "corpus",
      "provider",
      "model",
    ),
  ).toBe(true);
  expect(
    hasHostLinkedSynthesisRetry(
      [
        {
          kind: "linked_synthesis_retry",
          payload: {
            available: true,
            session_id: "other-chat",
            corpus_id: "corpus",
            provider_profile_id: "provider",
            model_id: "model",
          },
        },
      ],
      "chat",
      "corpus",
      "provider",
      "model",
    ),
  ).toBe(false);
  expect(
    hasHostLinkedSynthesisRetry(
      [
        {
          kind: "linked_synthesis_retry",
          payload: {
            available: true,
            session_id: "chat",
            corpus_id: "corpus",
            provider_profile_id: "other-provider",
            model_id: "model",
          },
        },
      ],
      "chat",
      "corpus",
      "provider",
      "model",
    ),
  ).toBe(false);
});

vi.mock("../../lib/host", () => ({
  modelSelectionKey: (providerId: string, modelId: string) =>
    `${providerId}::${modelId}`,
  parseModelSelectionKey: (key: string) => {
    const split = key.indexOf("::");
    return split > 0
      ? {
          providerId: key.slice(0, split),
          modelId: key.slice(split + 2),
        }
      : { providerId: null, modelId: key };
  },
  hostListChatModels: vi.fn(async () => []),
  hostListChatSessionsForCorpus: vi.fn(async () => []),
  hostLoadChatSession: vi.fn(async () => null),
  hostSaveChatSession: vi.fn(),
  hostSetChatLinkedCorpus: vi.fn(),
  hostCancelTurn: vi.fn(async () => undefined),
  hostSuppressDeveloperActivityDetail: vi.fn(async () => undefined),
  hostSetModelToolsEnabled: vi.fn(async () => true),
  hostRenameChatSession: vi.fn(),
  hostPinChatSession: vi.fn(),
  hostArchiveChatSession: vi.fn(),
  hostOpenLogExplorer: vi.fn(async () => "opened"),
  hostOpenLogExplorerTarget: vi.fn(async (corpusId: string, target) => ({
    windowLabel: `log-explorer-${corpusId}`,
    corpusId,
    target,
  })),
  agentTurn: vi.fn(async () => []),
}));

vi.mock("../../lib/engine/turnActivity", () => ({
  fetchTurnActivity: vi.fn(async () => null),
  fetchDeveloperTurnActivity: vi.fn(async () => []),
  forgetSessionActivity: vi.fn(async () => undefined),
}));

const defaultModels: host.ModelOptionDto[] = [
  {
    id: "triage-1",
    label: "triage-1",
    selection_key: "tools-provider::triage-1",
    provider_id: "tools-provider",
    provider_label: "Tools Provider",
    group: "Tools Provider",
    is_default: true,
    tools_enabled: true,
    tools_disabled_reason: null,
    availability: "discovered",
    availability_detail: null,
    hidden: false,
    hidden_by: null,
    pinned_rank: null,
  },
  {
    id: "chat-only",
    label: "chat-only",
    selection_key: "chat-provider::chat-only",
    provider_id: "chat-provider",
    provider_label: "Chat-only Provider",
    group: "Chat-only Provider",
    is_default: false,
    tools_enabled: false,
    tools_disabled_reason: "profile",
    availability: "discovered",
    availability_detail: null,
    hidden: false,
    hidden_by: null,
    pinned_rank: null,
  },
];

const baseContext: AgentContextSummary = {
  corpusId: "c1",
  timeQuality: "wall",
  linkMode: false,
  lanes: ["All:[*]"],
  levels: [],
  sources: [],
  keyword: null,
  selectedCount: 0,
  bookmarkCount: 0,
  brief: "corpusId=c1; timeQuality=wall",
  noisePolicyLabel: "inactive",
  noiseRuleCount: 0,
  noiseExcludedEventCount: 0,
  noisePolicyHiddenCount: 0,
  noiseExcludedNotAnalyzed: false,
  noiseLensSuspended: false,
  noiseDisclosure: "Noise inactive · 0 rules · 0 excluded",
};

function sessionDto(
  id: string,
  title: string,
  messages: { id: string; role: string; content: string }[] = [],
): host.ChatSessionDto {
  return {
    id,
    title,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      tools: null,
      citations: null,
      trail: null,
      meta: null,
    })),
    compact_keep_last: 6,
    show_full_history: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived: false,
    trashed: false,
    trashed_at: null,
    pinned: false,
    title_locked: false,
    chat_model: null,
    provider_profile_id: null,
    last_read_message_id: null,
    pinned_skill_id: null,
    linked_corpus_id: "c1",
  };
}

describe("LinkedChatRail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveDeveloperActivityDetail(false);
    vi.mocked(host.hostListChatModels).mockResolvedValue(defaultModels);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(null);
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostSetChatLinkedCorpus).mockImplementation(
      async (sessionId, corpusId, draftSession) => {
        if (!draftSession) return null;
        return host.hostSaveChatSession({
          ...draftSession,
          id: sessionId,
          linked_corpus_id: corpusId,
        });
      },
    );
    vi.mocked(host.hostCancelTurn).mockResolvedValue(undefined);
    vi.mocked(host.hostSuppressDeveloperActivityDetail).mockResolvedValue(
      undefined,
    );
    vi.mocked(host.hostSetModelToolsEnabled).mockResolvedValue(true);
    vi.mocked(host.hostRenameChatSession).mockResolvedValue(null);
    vi.mocked(host.hostPinChatSession).mockResolvedValue(null);
    vi.mocked(host.hostArchiveChatSession).mockResolvedValue(null);
    vi.mocked(host.agentTurn).mockResolvedValue([]);
  });

  it("shows active noise policy with excluded count and not-analyzed wording (#817)", async () => {
    const activeContext: AgentContextSummary = {
      ...baseContext,
      noisePolicyLabel: "active",
      noiseRuleCount: 2,
      noiseExcludedEventCount: 250,
      noisePolicyHiddenCount: 250,
      noiseExcludedNotAnalyzed: true,
      noiseLensSuspended: false,
      noiseDisclosure:
        "Noise active · 2 rules · 250 excluded · excluded events not analyzed · policy r7",
      brief:
        "corpusId=c1; noisePolicy=active; noiseRuleCount=2; noiseHiddenCount=250; noiseExcludedEventsNotAnalyzed=true",
    };
    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={activeContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("Context shared with agent"));
    const noise = await screen.findByTestId("linked-chat-noise-context");
    expect(noise.textContent).toMatch(/Noise policy/i);
    expect(noise.textContent).toMatch(/2 rules/);
    expect(noise.textContent).toMatch(/250 excluded/);
    expect(noise.textContent).toMatch(/not analyzed/i);
  });

  it("shows suspended noise lens honestly and passes noise_lens_suspended on agentTurn (#817)", async () => {
    let stored: host.ChatSessionDto | null = null;
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: false,
                pinned: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: "",
                linked_corpus_id: "c1",
              },
            ]
          : [],
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => {
      stored = {
        ...s,
        linked_corpus_id: s.linked_corpus_id ?? "c1",
        chat_model: s.chat_model ?? "triage-1",
        provider_profile_id: s.provider_profile_id ?? "tools-provider",
      };
      return stored;
    });
    vi.mocked(host.agentTurn).mockResolvedValue([]);

    const suspendedContext: AgentContextSummary = {
      ...baseContext,
      noisePolicyLabel: "suspended",
      noiseRuleCount: 2,
      noiseExcludedEventCount: 0,
      noisePolicyHiddenCount: 250,
      noiseExcludedNotAnalyzed: false,
      noiseLensSuspended: true,
      noiseDisclosure:
        "Noise lens suspended · 2 rules still enabled · 0 excluded now · policy would hide 250 · policy r7",
      brief:
        "corpusId=c1; noisePolicy=suspended; noiseLensSuspended=true; noiseExcludedFromView=0",
    };
    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={suspendedContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByText("Context shared with agent"));
    const noise = await screen.findByTestId("linked-chat-noise-context");
    expect(noise.textContent).toMatch(/suspended/i);
    expect(noise.textContent).toMatch(/0 excluded now/);
    expect(noise.textContent).toMatch(/would hide 250/);

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "What problems remain?" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await waitFor(() => expect(host.agentTurn).toHaveBeenCalled());
    const turnArgs = vi.mocked(host.agentTurn).mock.calls.at(-1);
    expect(turnArgs?.[7]).toEqual(
      expect.objectContaining({
        corpus_id: "c1",
        noise_lens_suspended: true,
      }),
    );
  });

  it("explains the bounded linked-chat context and privacy boundary", async () => {
    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Help: How linked chat context works",
      }),
    );
    const help = await screen.findByRole("dialog", {
      name: "Linked chat and agent context",
    });
    expect(help.textContent).toContain("small immutable snapshot");
    expect(help.textContent).toContain("bounded result pages");
    expect(help.textContent).toContain("tools-enabled provider profile");
    expect(help.textContent).toContain("workspace/Markdown");
    expect(help.textContent).toContain("Skills and synthesis");
    expect(help.textContent).toContain("permission-blocked sources");
    expect(help.textContent).toContain("Raw corpus dumps");
    expect(help.textContent).toContain(
      "Switching chats cannot move a pending turn",
    );
  });

  it("keeps a prepared investigation prompt mounted across rail mode changes", async () => {
    const view = render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        visible={false}
        externalDraftRequest={{
          id: 1,
          text: "Investigate selected seq 2 and 9",
        }}
        modeControl={<button type="button">Evidence or chat</button>}
      />,
    );

    expect(
      screen
        .getByLabelText("Chat message")
        .closest("aside")
        ?.hasAttribute("hidden"),
    ).toBe(true);
    view.rerender(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        visible
        externalDraftRequest={{
          id: 1,
          text: "Investigate selected seq 2 and 9",
        }}
        modeControl={<button type="button">Evidence or chat</button>}
      />,
    );

    const composer = await screen.findByLabelText("Chat message");
    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toBe(
        "Investigate selected seq 2 and 9",
      );
      expect(document.activeElement).toBe(composer);
    });
    expect(
      screen.getByRole("button", { name: "Evidence or chat" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const thread = screen.getByTestId("log-explorer-chat-thread");
    Object.defineProperties(thread, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, writable: true, value: 37 },
    });
    fireEvent.scroll(thread);

    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    view.rerender(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        visible
        externalDraftRequest={{
          id: 2,
          text: "Investigate selected seq 10",
        }}
      />,
    );
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).value).toBe(
        "Keep this draft\n\nSelected evidence:\nInvestigate selected seq 10",
      ),
    );
    view.rerender(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        visible={false}
        externalDraftRequest={{
          id: 2,
          text: "Investigate selected seq 10",
        }}
      />,
    );
    view.rerender(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        visible
        externalDraftRequest={{
          id: 2,
          text: "Investigate selected seq 10",
        }}
      />,
    );

    expect(
      ((await screen.findByLabelText("Chat message")) as HTMLTextAreaElement)
        .value,
    ).toBe(
      "Keep this draft\n\nSelected evidence:\nInvestigate selected seq 10",
    );
    expect(screen.getByTestId("log-explorer-chat-thread").scrollTop).toBe(37);
  });

  it("shows the configured model, persists a per-chat change, and sends explicit provider arguments", async () => {
    const models: host.ModelOptionDto[] = [
      defaultModels[0]!,
      {
        id: "forensics-2",
        label: "forensics-2",
        selection_key: "forensics-provider::forensics-2",
        provider_id: "forensics-provider",
        provider_label: "Forensics Provider",
        group: "Forensics Provider",
        is_default: false,
        tools_enabled: true,
        tools_disabled_reason: null,
        availability: "discovered",
        availability_detail: null,
        hidden: false,
        hidden_by: null,
        pinned_rank: null,
      },
      defaultModels[1]!,
    ];
    vi.mocked(host.hostListChatModels).mockResolvedValue(models);
    let stored: host.ChatSessionDto | null = null;
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: false,
                pinned: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: stored.messages.at(-1)?.content ?? "",
                linked_corpus_id: "c1",
              },
            ]
          : [],
    );

    const first = render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    const selector = (await screen.findByLabelText(
      "Linked chat model",
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(selector.value).toBe("tools-provider::triage-1"),
    );
    expect(
      (
        within(selector).getByRole("option", {
          name: /chat-only.*not verified.*tools unavailable/,
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => {
      expect(stored?.chat_model).toBe("triage-1");
      expect(stored?.provider_profile_id).toBe("tools-provider");
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("linked-chat-manage-toggle") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    fireEvent.change(selector, {
      target: { value: "forensics-provider::forensics-2" },
    });
    await waitFor(() => {
      expect(stored?.chat_model).toBe("forensics-2");
      expect(stored?.provider_profile_id).toBe("forensics-provider");
    });

    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Investigate the failure" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await waitFor(() => expect(host.agentTurn).toHaveBeenCalledTimes(1));
    expect(host.agentTurn).toHaveBeenCalledWith(
      expect.any(String),
      "Investigate the failure",
      false,
      "forensics-2",
      "forensics-provider",
      expect.any(Function),
      null,
      expect.objectContaining({ corpus_id: "c1" }),
      false,
      expect.objectContaining({
        userMessageId: expect.any(String),
        assistantMessageId: expect.any(String),
      }),
    );

    first.unmount();
    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Logs · fixture",
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Linked chat model") as HTMLSelectElement).value,
      ).toBe("forensics-provider::forensics-2"),
    );
  });

  it("reports truncated model choices with the exact Settings search route", async () => {
    const models: host.ModelOptionDto[] = Array.from(
      { length: 250 },
      (_, i) => ({
        id: `model-${i}`,
        label: `model-${i}`,
        selection_key: `gateway::model-${i}`,
        provider_id: "gateway",
        provider_label: "Gateway",
        group: "Gateway",
        is_default: i === 0,
        tools_enabled: true,
        tools_disabled_reason: null,
        availability: "discovered",
        availability_detail: null,
        hidden: false,
        hidden_by: null,
        pinned_rank: null,
      }),
    );
    vi.mocked(host.hostListChatModels).mockResolvedValue(models);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    const selector = (await screen.findByLabelText(
      "Linked chat model",
    )) as HTMLSelectElement;
    await waitFor(() => expect(selector.options).toHaveLength(200));
    expect(
      screen.getByText(
        /Showing 200 choices; 50 more are omitted\. Find them in Settings → AI → Model visibility using Search models\./i,
      ),
    ).toBeTruthy();
  });

  it("blocks a chat-only provider from masquerading as a linked investigation model", async () => {
    const chatOnly = {
      ...defaultModels[1]!,
      is_default: true,
    };
    vi.mocked(host.hostListChatModels).mockResolvedValue([chatOnly]);
    let stored = sessionDto("chat-only-session", "Logs · fixture");
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    const selector = (await screen.findByLabelText(
      "Linked chat model",
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(selector.value).toBe("chat-provider::chat-only"),
    );
    expect(screen.getByText(/linked tools unavailable/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "Pretend to investigate" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    expect(
      await screen.findByText(
        /cannot investigate linked logs because its provider has tools disabled/i,
      ),
    ).toBeTruthy();
    expect(host.agentTurn).not.toHaveBeenCalled();
  });

  it("retries a learned model-specific tool rejection without changing the provider", async () => {
    const learnedDisabled: host.ModelOptionDto = {
      ...defaultModels[0]!,
      tools_enabled: false,
      tools_disabled_reason: "model",
    };
    const reenabled: host.ModelOptionDto = {
      ...learnedDisabled,
      tools_enabled: true,
      tools_disabled_reason: null,
    };
    vi.mocked(host.hostListChatModels)
      .mockResolvedValueOnce([learnedDisabled])
      .mockResolvedValue([reenabled]);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    const selector = (await screen.findByLabelText(
      "Linked chat model",
    )) as HTMLSelectElement;
    expect(selector.options[0]?.disabled).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Retry tools" }));

    await waitFor(() =>
      expect(host.hostSetModelToolsEnabled).toHaveBeenCalledWith({
        providerId: "tools-provider",
        modelId: "triage-1",
        toolsEnabled: true,
      }),
    );
    expect(await screen.findByText(/linked tools available/i)).toBeTruthy();
  });

  it("auto-creates a linked chat for the first question and preserves keyboard composer behavior", async () => {
    let stored: host.ChatSessionDto | null = null;
    let createdSessionId: string | null = null;
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      createdSessionId ??= session.id;
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: false,
                pinned: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: stored.messages.at(-1)?.content ?? "",
                linked_corpus_id: "c1",
              },
            ]
          : [],
    );
    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        }),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    const composer = (await screen.findByLabelText(
      "Chat message",
    )) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: "line one" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(host.agentTurn).not.toHaveBeenCalled();
    expect(composer.value).toBe("line one");

    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(host.agentTurn).toHaveBeenCalledTimes(1));
    expect(createdSessionId).not.toBeNull();
    expect(host.hostSetChatLinkedCorpus).toHaveBeenCalledWith(
      createdSessionId,
      "c1",
      expect.objectContaining({
        id: createdSessionId,
        linked_corpus_id: "c1",
        messages: [],
      }),
      expect.any(String),
    );
    expect(host.agentTurn).toHaveBeenCalledWith(
      createdSessionId,
      "line one",
      false,
      "triage-1",
      "tools-provider",
      expect.any(Function),
      null,
      expect.objectContaining({ corpus_id: "c1" }),
      false,
      expect.objectContaining({
        userMessageId: expect.any(String),
        assistantMessageId: expect.any(String),
      }),
    );
    expect(
      vi.mocked(host.hostSaveChatSession).mock.calls[0]?.[0].linked_corpus_id,
    ).toBe("c1");
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).disabled,
    ).toBe(true);

    await act(async () => {
      resolveTurn?.([
        { kind: "text_delta", payload: { text: "Grounded response." } },
        { kind: "turn_completed", payload: {} },
      ]);
    });
    expect(await screen.findByText("Grounded response.")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Chat message"),
      ),
    );
  });

  it("suppresses an in-flight linked turn exactly once when Developer detail turns Off", async () => {
    let stored: host.ChatSessionDto | null = null;
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: false,
                pinned: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: stored.messages.at(-1)?.content ?? "",
                linked_corpus_id: "c1",
              },
            ]
          : [],
    );
    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        }),
    );
    saveDeveloperActivityDetail(true);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    const composer = await screen.findByLabelText("Chat message");
    fireEvent.change(composer, { target: { value: "Inspect the failure" } });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await waitFor(() => expect(host.agentTurn).toHaveBeenCalledTimes(1));
    const sessionId = vi.mocked(host.agentTurn).mock.calls[0]?.[0];
    expect(sessionId).toEqual(expect.any(String));
    expect(vi.mocked(host.agentTurn).mock.calls[0]?.[9]).toEqual(
      expect.objectContaining({ developerActivityDetail: true }),
    );

    act(() => saveDeveloperActivityDetail(false));
    await waitFor(() =>
      expect(host.hostSuppressDeveloperActivityDetail).toHaveBeenCalledWith(
        sessionId,
      ),
    );
    act(() => saveDeveloperActivityDetail(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.hostSuppressDeveloperActivityDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTurn?.([{ kind: "turn_completed", payload: {} }]);
    });
  });

  it("stops before the first turn when governed linked-chat creation fails", async () => {
    vi.mocked(host.hostSetChatLinkedCorpus).mockRejectedValueOnce(
      new Error("linked corpus artifacts are unavailable"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    const composer = await screen.findByLabelText("Chat message");
    fireEvent.change(composer, {
      target: { value: "Investigate this corpus" },
    });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(
      await screen.findByText(/linked corpus artifacts are unavailable/i),
    ).toBeTruthy();
    expect(host.agentTurn).not.toHaveBeenCalled();
    expect(host.hostSaveChatSession).not.toHaveBeenCalled();
    expect(screen.getByText("No chat selected")).toBeTruthy();
  });

  it("coalesces concurrent New and Send into one durable linked session (#709)", async () => {
    // Dual-enter createLinkedChat itself (New button + Send with no active
    // chat). This is not satisfied by creatingTurnChatRef alone — both paths
    // call createLinkedChat, so only createLinkedChatInflightRef coalesce
    // keeps a single host create.
    let resolveCreate:
      | ((session: host.ChatSessionDto) => void)
      | null = null;
    const createGate = new Promise<host.ChatSessionDto>((resolve) => {
      resolveCreate = resolve;
    });
    const createdIds: string[] = [];
    let createEntries = 0;
    vi.mocked(host.hostSetChatLinkedCorpus).mockImplementation(
      async (sessionId, corpusId, draftSession) => {
        if (!draftSession) return null;
        createEntries += 1;
        createdIds.push(sessionId);
        const saved: host.ChatSessionDto = {
          ...draftSession,
          id: sessionId,
          linked_corpus_id: corpusId,
        };
        // Hold the first create open so New+Send both enter createLinkedChat.
        await createGate;
        return host.hostSaveChatSession(saved);
      },
    );
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        createdIds.map((id) => ({
          id,
          title: "Logs · c1",
          archived: false,
          pinned: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          message_count: 0,
          preview: "",
          linked_corpus_id: "c1",
        })),
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) => {
      const base = sessionDto(id, "Logs · c1");
      return {
        ...base,
        chat_model: "triage-1",
        provider_profile_id: "tools-provider",
        linked_corpus_id: "c1",
      };
    });
    vi.mocked(host.agentTurn).mockResolvedValue([
      { kind: "text_delta", payload: { text: "one" } },
      { kind: "turn_completed", payload: {} },
    ]);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    const composer = (await screen.findByLabelText(
      "Chat message",
    )) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "race me" } });

    // New starts createLinkedChat; Send (no activeChatId yet) also enters it.
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(host.hostSetChatLinkedCorpus).toHaveBeenCalledTimes(1),
    );
    expect(createEntries).toBe(1);
    expect(createdIds).toHaveLength(1);

    await act(async () => {
      const base = sessionDto(createdIds[0]!, "Logs · c1");
      resolveCreate?.({
        ...base,
        chat_model: "triage-1",
        provider_profile_id: "tools-provider",
        linked_corpus_id: "c1",
      });
    });

    // Send's turn proceeds on the single created session.
    await waitFor(() => expect(host.agentTurn).toHaveBeenCalledTimes(1));
    expect(host.agentTurn).toHaveBeenCalledWith(
      createdIds[0],
      "race me",
      false,
      "triage-1",
      "tools-provider",
      expect.any(Function),
      null,
      expect.objectContaining({ corpus_id: "c1" }),
      false,
      expect.any(Object),
    );
    expect(new Set(createdIds).size).toBe(1);
  });

  it("reveals same-corpus log_event citations and fails closed for legacy/malformed (#701/#698)", async () => {
    const onApplyNav = vi.fn();
    let stored = sessionDto("chat-cite", "Citation chat");
    stored.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Grounded finding",
        tools: null,
        citations: [
          {
            id: "log_event:42",
            label: "log_event:42",
            corpusId: "c1",
          },
          {
            id: "log_template:7",
            label: "log_template:7",
            // legacy unbound — no corpusId
          },
          {
            id: "unknown://x",
            label: "unknown://x",
          },
        ],
        trail: null,
        meta: null,
      },
    ] as host.ChatSessionDto["messages"];
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: "Grounded finding",
          linked_corpus_id: "c1",
        },
      ],
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={onApplyNav}
      />,
    );

    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Citation chat",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("linked-chat-msg-assistant")).toBeTruthy(),
    );

    // Open Sources and activate log_event via host exact-nav (same path as main chat).
    fireEvent.click(await screen.findByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "log_event:42" }));
    await waitFor(() =>
      expect(host.hostOpenLogExplorerTarget).toHaveBeenCalledWith("c1", {
        kind: "event",
        id: "42",
      }),
    );
    // Local log_nav shortcut is no longer used — host owns exact reveal.
    expect(onApplyNav).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/Opened log_event:42/i)).toBeTruthy(),
    );

    // Legacy unbound fails closed — no substitute.
    fireEvent.click(screen.getByRole("button", { name: "log_template:7" }));
    expect(
      await screen.findByText(/does not record its original corpus/i),
    ).toBeTruthy();

    // Malformed scheme never becomes file I/O.
    fireEvent.click(screen.getByRole("button", { name: "unknown://x" }));
    expect(
      await screen.findByText(/unsupported or malformed/i),
    ).toBeTruthy();
  });

  it("does not claim Opened status when host exact-nav fails", async () => {
    let stored = sessionDto("chat-cite-fail", "Citation fail");
    stored.messages = [
      {
        id: "a1",
        role: "assistant",
        content: "see source",
        tools: undefined,
        citations: [
          {
            id: "log_event:42",
            label: "log_event:42",
            title: undefined,
            corpusId: "c1",
          },
        ],
        trail: undefined,
        meta: undefined,
      },
    ];
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: "",
          linked_corpus_id: "c1",
        },
      ],
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostOpenLogExplorerTarget).mockRejectedValue(
      new Error("event 42 was not found in this corpus"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Citation fail",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("linked-chat-msg-assistant")).toBeTruthy(),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "log_event:42" }));

    expect(
      await screen.findByText(/original log corpus.*unavailable[\s\S]*not found/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Opened log_event:42/i)).toBeNull();
  });

  it("stops the exact active session once and waits for the host terminal event", async () => {
    let stored = sessionDto("chat-stop", "Slow investigation");
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: stored.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        },
      ],
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });

    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        }),
    );
    let resolveCancellation: (() => void) | null = null;
    vi.mocked(host.hostCancelTurn).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCancellation = resolve;
        }),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Slow investigation",
      ),
    );
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "Find the failure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const stop = await screen.findByRole("button", { name: /Stop/ });
    stop.focus();
    fireEvent.click(stop);
    fireEvent.click(stop);

    expect(host.hostCancelTurn).toHaveBeenCalledTimes(1);
    expect(host.hostCancelTurn).toHaveBeenCalledWith("chat-stop");
    expect(
      await screen.findByText(
        "Cancellation requested. Waiting for the current turn to stop…",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stopping/ })).toBe(stop);
    expect(document.activeElement).toBe(stop);

    await act(async () => {
      resolveCancellation?.();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /Stopping/ })).toBeTruthy();

    await act(async () => {
      resolveTurn?.([
        {
          kind: "error",
          payload: { code: "cancelled", message: "Turn cancelled by user." },
        },
        { kind: "turn_completed", payload: { reason: "cancelled" } },
      ]);
    });

    expect(
      await screen.findByText(
        /Linked investigation stopped with Tools Provider · triage-1/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Cancellation requested. Waiting for the current turn to stop…",
      ),
    ).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Chat message"),
      ),
    );
  });

  it("shows cancellation request failure and safely allows retry", async () => {
    const stored = sessionDto("chat-retry-stop", "Retry cancellation");
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: stored.id,
        title: stored.title,
        archived: false,
        pinned: false,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(stored);
    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        }),
    );
    vi.mocked(host.hostCancelTurn)
      .mockRejectedValueOnce(new Error("cancellation channel unavailable"))
      .mockResolvedValueOnce(undefined);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Retry cancellation",
      ),
    );
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "Start a slow turn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: /Stop/ }));

    expect(
      await screen.findByText(
        /Could not request cancellation: Error: cancellation channel unavailable/,
      ),
    ).toBeTruthy();
    const retry = screen.getByRole("button", { name: /Stop/ });
    expect(retry.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(retry);
    await waitFor(() =>
      expect(host.hostCancelTurn).toHaveBeenNthCalledWith(2, "chat-retry-stop"),
    );
    expect(screen.getByRole("button", { name: /Stopping/ })).toBeTruthy();
    expect(
      screen.getByText(
        "Cancellation requested. Waiting for the current turn to stop…",
      ),
    ).toBeTruthy();

    await act(async () => {
      resolveTurn?.([
        {
          kind: "error",
          payload: { code: "cancelled", message: "Turn cancelled by user." },
        },
        { kind: "turn_completed", payload: { reason: "cancelled" } },
      ]);
    });
    expect(
      await screen.findByText(
        /Linked investigation stopped with Tools Provider · triage-1/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/cancellation channel unavailable/)).toBeNull();
  });

  it("keeps Stop routing isolated when two chats are busy", async () => {
    const sessions = new Map([
      ["chat-a", sessionDto("chat-a", "Chat A")],
      ["chat-b", sessionDto("chat-b", "Chat B")],
    ]);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(async () =>
      [...sessions.values()].map((session) => ({
        id: session.id,
        title: session.title,
        archived: false,
        pinned: false,
        created_at: session.created_at,
        updated_at: session.updated_at,
        message_count: session.messages.length,
        preview: session.messages.at(-1)?.content ?? "",
        linked_corpus_id: "c1",
      })),
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      async (id) => sessions.get(id) ?? null,
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      sessions.set(session.id, session);
      return session;
    });

    const turnResolvers = new Map<string, (events: host.EventDto[]) => void>();
    vi.mocked(host.agentTurn).mockImplementation(
      async (id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          turnResolvers.set(id, (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          });
        }),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    const openChat = async (name: string) => {
      fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
      fireEvent.click(
        within(screen.getByTestId("linked-chat-switcher")).getByText(name),
      );
      await screen.findByTitle(name);
    };
    const startTurn = async (prompt: string) => {
      fireEvent.change(await screen.findByLabelText("Chat message"), {
        target: { value: prompt },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByRole("button", { name: /Stop/ });
    };

    await openChat("Chat A");
    await startTurn("Investigate A");
    await openChat("Chat B");
    await startTurn("Investigate B");

    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(host.hostCancelTurn).toHaveBeenLastCalledWith("chat-b");

    await openChat("Chat A");
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(host.hostCancelTurn).toHaveBeenNthCalledWith(2, "chat-a");
    expect(host.hostCancelTurn).toHaveBeenCalledTimes(2);

    await act(async () => {
      for (const resolve of turnResolvers.values()) {
        resolve([
          {
            kind: "error",
            payload: { code: "cancelled", message: "Turn cancelled by user." },
          },
          { kind: "turn_completed", payload: { reason: "cancelled" } },
        ]);
      }
    });
  });

  it("collapses to an accessible reopen strip without losing the active draft", async () => {
    const active = sessionDto("chat-a", "Chat A");
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: active.id,
        title: active.title,
        archived: false,
        pinned: false,
        created_at: active.created_at,
        updated_at: active.updated_at,
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(active);
    const onToggleCollapsed = vi.fn();
    const renderRail = (collapsed: boolean) => (
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
      />
    );
    const { rerender } = render(renderRail(false));

    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    const composer = await screen.findByLabelText("Chat message");
    fireEvent.change(composer, { target: { value: "keep this draft" } });
    const thread = screen.getByTestId("log-explorer-chat-thread");
    thread.scrollTop = 144;
    fireEvent.click(screen.getByTestId("collapse-linked-chat"));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

    rerender(renderRail(true));
    expect(screen.queryByLabelText("Chat message")).toBeNull();
    const reopen = screen.getByTestId("expand-linked-chat");
    expect(reopen.getAttribute("aria-label")).toBe(
      "Expand linked chat rail, 1 chat",
    );
    await waitFor(() => expect(document.activeElement).toBe(reopen));
    fireEvent.click(reopen);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(2);

    rerender(renderRail(false));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("collapse-linked-chat"),
      ),
    );
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).value,
    ).toBe("keep this draft");
    expect(screen.getByTestId("log-explorer-chat-thread").scrollTop).toBe(144);
  });

  it("keeps governed cross-source tools and citations visible with the linked answer", async () => {
    let stored: host.ChatSessionDto | null = null;
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      stored?.id === id ? stored : null,
    );
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: stored.archived,
                pinned: stored.pinned,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: stored.messages.at(-1)?.content ?? "",
                linked_corpus_id: stored.linked_corpus_id,
              },
            ]
          : [],
    );
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "tool",
            payload: {
              id: "log-tool",
              name: "search_logs",
              phase: "finished",
              summary: "1 log hit",
              ok: true,
            },
          },
          {
            kind: "citation",
            payload: {
              source_id: "log_template:7",
              label: "log_template:7",
            },
          },
          {
            kind: "tool",
            payload: {
              id: "runbook-tool",
              name: "search_kb",
              phase: "finished",
              summary: "1 workspace hit",
              ok: true,
            },
          },
          {
            kind: "citation",
            payload: {
              source_id: "/workspace/checkout-runbook.md",
              label: "checkout-runbook.md",
            },
          },
          {
            kind: "citation",
            payload: {
              source_id: "memory:decision-1",
              label: "memory:decision-1",
            },
          },
          {
            kind: "citation",
            payload: {
              source_id: "sql:incident-db",
              label: "sql:incident-db",
            },
          },
          {
            kind: "text_delta",
            payload: {
              text: "Observed log failure; supporting runbook, memory, and SQL evidence agree.",
            },
          },
          {
            kind: "search_trail",
            payload: {
              steps: [
                "tool:search_logs",
                "tool:search_kb",
                "tool:recall_memory",
                "tool:sql_query__incident-db",
              ],
            },
          },
          { kind: "turn_completed", payload: { reason: "stop" } },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        developerMode
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(stored?.linked_corpus_id).toBe("c1"));

    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Cross-check the incident evidence" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    expect(
      await screen.findByText(
        "Linked investigation completed with governed evidence retrieval",
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId("linked-evidence-trust-disclosure").textContent,
    ).toBe("Evidence references verified · model interpretation not verified");
    expect(screen.getByText("search_logs")).toBeTruthy();
    expect(screen.getByText("search_kb")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getAllByText("checkout-runbook.md").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("memory:decision-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sql:incident-db").length).toBeGreaterThan(0);
    const technicalSummary = screen.getByText("Technical details");
    const technical = technicalSummary.closest("details");
    expect(technical?.open).toBe(false);
    fireEvent.click(technicalSummary);
    expect(technical?.open).toBe(true);
    expect(
      within(technical!).getByLabelText("Search trail").textContent,
    ).toContain("tool:search_logs");

    fireEvent.click(screen.getByText("Context shared with agent"));
    const context = screen.getByTestId("linked-chat-agent-context");
    expect(context.textContent).toContain("Eligible evidence");
    expect(context.textContent).toContain("workspace/Markdown");
    expect(context.textContent).toContain("Retrieval and synthesis");
    expect(context.textContent).toContain("Process instructions only");
    expect(screen.getByTestId("linked-chat-noise-context").textContent).toMatch(
      /Noise policy/i,
    );
    expect(screen.getByTestId("linked-chat-noise-context").textContent).toMatch(
      /0 rules|inactive/i,
    );

    await waitFor(() =>
      expect(
        stored?.messages.some(
          (message) =>
            message.role === "assistant" &&
            Array.isArray(message.citations) &&
            message.citations.length === 4,
        ),
      ).toBe(true),
    );
  });

  it("renames, pins, archives, and reopens only the active linked chat", async () => {
    let stored = sessionDto("s1", "Incident chat");
    const meta = (): host.SessionMetaDto => ({
      id: stored.id,
      title: stored.title,
      archived: stored.archived,
      pinned: stored.pinned,
      created_at: stored.created_at,
      updated_at: stored.updated_at,
      message_count: stored.messages.length,
      preview: "",
      linked_corpus_id: "c1",
    });
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [meta()],
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostRenameChatSession).mockImplementation(
      async (id, title) => {
        expect(id).toBe("s1");
        stored = { ...stored, title, title_locked: true };
        return stored;
      },
    );
    vi.mocked(host.hostPinChatSession).mockImplementation(
      async (id, pinned) => {
        expect(id).toBe("s1");
        stored = { ...stored, pinned };
        return stored;
      },
    );
    vi.mocked(host.hostArchiveChatSession).mockImplementation(
      async (id, archived) => {
        expect(id).toBe("s1");
        stored = { ...stored, archived };
        return stored;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Incident chat",
      ),
    );
    fireEvent.click(await screen.findByTestId("linked-chat-manage-toggle"));
    const manage = await screen.findByRole("dialog", {
      name: "Manage Incident chat",
    });

    fireEvent.change(within(manage).getByLabelText("Chat title"), {
      target: { value: "Checkout evidence" },
    });
    fireEvent.click(within(manage).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(host.hostRenameChatSession).toHaveBeenCalledWith(
        "s1",
        "Checkout evidence",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("Checkout evidence")).toBeTruthy(),
    );

    fireEvent.click(within(manage).getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(host.hostPinChatSession).toHaveBeenCalledWith("s1", true),
    );
    await waitFor(() =>
      expect(
        within(manage).getByRole("button", { name: "Unpin" }),
      ).toBeTruthy(),
    );

    fireEvent.click(within(manage).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(host.hostArchiveChatSession).toHaveBeenCalledWith("s1", true),
    );
    await waitFor(() =>
      expect(
        within(manage).getByRole("button", { name: "Reopen" }),
      ).toBeTruthy(),
    );
    fireEvent.click(within(manage).getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(host.hostArchiveChatSession).toHaveBeenLastCalledWith("s1", false),
    );

    fireEvent.keyDown(manage, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-manage")).toBeNull(),
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("linked-chat-manage-toggle"),
    );
  });

  it("keeps a compact header for 0, 1, 5, and 50 chats without stacking the list", async () => {
    const makeMetas = (n: number): host.SessionMetaDto[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `chat-${i}`,
        title: `Investigation ${i}`,
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 1,
        preview: `preview ${i}`,
        linked_corpus_id: "c1",
      }));

    for (const n of [0, 1, 5, 50]) {
      vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue(
        makeMetas(n),
      );
      const { unmount, container } = render(
        <div style={{ height: 640, display: "flex" }}>
          <LinkedChatRail
            corpusId="c1"
            corpusName="fixture"
            agentContext={baseContext}
            onApplyNav={() => undefined}
          />
        </div>,
      );
      await screen.findByTestId("linked-chat-header");
      // Steady-state: chat list is not permanently stacked above the thread.
      expect(screen.queryByTestId("linked-chat-switcher")).toBeNull();
      expect(screen.getByTestId("log-explorer-chat-thread")).toBeTruthy();
      expect(screen.getByTestId("log-explorer-chat-composer")).toBeTruthy();
      await waitFor(() =>
        expect(container.textContent).toMatch(
          new RegExp(`${n} chat${n === 1 ? "" : "s"}`),
        ),
      );

      if (n > 0) {
        fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
        const switcher = await screen.findByTestId("linked-chat-switcher");
        expect(within(switcher).getAllByRole("option").length).toBe(
          Math.min(n, 50),
        );
        if (n >= 8) {
          expect(
            screen.getByTestId("linked-chat-switcher-search"),
          ).toBeTruthy();
        }
        // Thread still present and not replaced by the list.
        expect(screen.getByTestId("log-explorer-chat-thread")).toBeTruthy();
      }
      unmount();
    }
  });

  it("auto-follows appended messages while near bottom and offers jump when detached", async () => {
    let stored = sessionDto("s1", "Logs · fixture");
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => {
      stored = s;
      return s;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: stored.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        },
      ],
    );

    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) => {
        return new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        });
      },
    );

    render(
      <div style={{ height: 480 }}>
        <LinkedChatRail
          corpusId="c1"
          corpusName="fixture"
          agentContext={baseContext}
          onApplyNav={() => undefined}
        />
      </div>,
    );

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(stored.linked_corpus_id).toBe("c1"));

    // Seed a long thread so the viewport can detach.
    const longHistory = Array.from({ length: 24 }, (_, i) => ({
      id: `h-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `History line ${i} — ${"x".repeat(40)}`,
    }));
    stored = sessionDto("s1", "Logs · fixture", longHistory);
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Logs · fixture",
      ),
    );
    const thread = await screen.findByTestId("log-explorer-chat-thread");
    await within(thread).findByText(/History line 23/);

    // Detach: scroll to top intentionally.
    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(thread, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    fireEvent.scroll(thread);
    await waitFor(() =>
      expect(screen.getByTestId("linked-chat-jump-latest")).toBeTruthy(),
    );

    // Sending re-engages follow.
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Continue investigation" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-jump-latest")).toBeNull(),
    );

    // The user may scroll away again while the provider is still working.
    thread.scrollTop = 0;
    fireEvent.scroll(thread);
    const existingJump = await screen.findByTestId("linked-chat-jump-latest");
    expect(existingJump.textContent).toBe("Jump to latest");

    await act(async () => {
      resolveTurn?.([
        {
          kind: "text_delta",
          payload: { text: "Fresh assistant evidence answer." },
        },
        { kind: "turn_completed", payload: {} },
      ]);
    });

    expect(
      await within(thread).findByText("Fresh assistant evidence answer."),
    ).toBeTruthy();
    expect(screen.getByTestId("linked-chat-jump-latest").textContent).toBe(
      "New response · Jump to latest",
    );
    fireEvent.click(screen.getByTestId("linked-chat-jump-latest"));
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-jump-latest")).toBeNull(),
    );
    expect(
      await within(thread).findByText("Continue investigation"),
    ).toBeTruthy();
  });

  it("persists and visibly surfaces a tools-disabled linked result", async () => {
    let stored = sessionDto("s-tools-off", "Logs · fixture");
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: stored.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        },
      ],
    );
    const unavailable =
      "Linked log investigation is unavailable because profile “Grok Build session” has tools disabled (capabilities.tools=false). Select or configure a tools-enabled profile in Settings → AI, then retry this linked chat.";
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "error",
            payload: {
              code: "linked_tools_unavailable",
              message: unavailable,
            },
          },
          {
            kind: "turn_completed",
            payload: { reason: "linked_tools_unavailable" },
          },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(stored.linked_corpus_id).toBe("c1"));
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Investigate with the linked log tools" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    const assistant = await screen.findByTestId("linked-chat-msg-assistant");
    expect(assistant.textContent).toContain(unavailable);
    expect(screen.queryByTestId("linked-evidence-trust-disclosure")).toBeNull();
    expect(assistant.textContent).not.toContain("**Error:**");
    expect(
      within(assistant).getByText("Error:", { selector: "strong" }),
    ).toBeTruthy();
    expect(screen.queryByText(/I'll use .*log tool/i)).toBeNull();
    await screen.findByText(
      /Linked investigation stopped with Tools Provider · triage-1/i,
    );
    await waitFor(() =>
      expect(
        stored.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.includes("capabilities.tools=false"),
        ),
      ).toBe(true),
    );
  });

  it("ends streaming, keeps a host-readiness error visible, and permits retry", async () => {
    let stored = sessionDto("s-host-timeout", "Logs · fixture");
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: stored.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        },
      ],
    );
    vi.mocked(host.agentTurn)
      .mockRejectedValueOnce(
        new Error(
          "Workspace access timed out before the linked investigation could start. Re-select or grant access to the workspace, then retry.",
        ),
      )
      .mockImplementationOnce(async (_id, _text, _fl, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "text_delta",
            payload: { text: "Retry completed with workspace access." },
          },
          { kind: "turn_completed", payload: {} },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      });

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "Investigate the corpus" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Workspace access timed out",
    );
    expect(screen.queryByText(/assistant · streaming/i)).toBeNull();
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).disabled,
    ).toBe(false);

    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Retry the investigation" },
    });
    const send = screen.getByTestId("send-linked-chat") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(
      await screen.findByText("Retry completed with workspace access."),
    ).toBeTruthy();
    await screen.findByText("Linked chat response saved");
    expect(host.agentTurn).toHaveBeenCalledTimes(2);
  });

  it("preserves governed evidence and retries synthesis without another user turn or retrieval", async () => {
    let stored = sessionDto("s-tool-deadline", "Logs · fixture");
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: stored.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        },
      ],
    );
    vi.mocked(host.agentTurn)
      .mockImplementationOnce(
        async (id, _text, _fl, model, provider, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "turn_phase",
            payload: { phase: "choosing_evidence" },
          },
          {
            kind: "turn_phase",
            payload: { phase: "retrieving_evidence" },
          },
          {
            kind: "tool",
            payload: {
              id: "search-1",
              name: "search_logs",
              summary: "1 matching log event",
              ok: true,
            },
          },
          {
            kind: "turn_phase",
            payload: { phase: "synthesizing_answer" },
          },
          {
            kind: "error",
            payload: {
              code: "linked_synthesis_timeout",
              message:
                "Answer synthesis reached its bounded deadline. The successful log evidence above is preserved.",
            },
          },
          {
            kind: "linked_synthesis_retry",
            payload: {
              available: true,
              session_id: id,
              corpus_id: "c1",
              provider_profile_id: provider,
              model_id: model,
            },
          },
          {
            kind: "turn_completed",
            payload: { reason: "linked_synthesis_timeout" },
          },
        ];
        for (const event of events) onEvent?.(event);
        return events;
        },
      )
      .mockImplementationOnce(async (_id, text, _fl, _m, _p, onEvent) => {
        expect(text).toBe("");
        const events: host.EventDto[] = [
          {
            kind: "turn_phase",
            payload: { phase: "synthesizing_answer" },
          },
          {
            kind: "text_delta",
            payload: {
              text: "Observed the failure at seq=0 source=worker.log.",
            },
          },
          { kind: "turn_completed", payload: { reason: "stop" } },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      });

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "Investigate the exact log identity" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toContain("Bounded evidence is preserved"),
    );
    expect(status.textContent).not.toContain("completed with governed");
    expect(
      screen.getByTestId("linked-chat-msg-assistant").textContent,
    ).toContain("successful log evidence above is preserved");
    expect(screen.getByText("search_logs")).toBeTruthy();
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("retry-linked-synthesis"));
    expect(
      await screen.findByText(
        "Observed the failure at seq=0 source=worker.log.",
      ),
    ).toBeTruthy();
    expect(host.agentTurn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(host.agentTurn).mock.calls[1]?.[8]).toBe(true);
    expect(screen.queryByTestId("retry-linked-synthesis")).toBeNull();
    expect(stored.messages).toHaveLength(3);
    expect(
      stored.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("persists a post-retrieval provider failure and trusts only its bound retry event", async () => {
    let stored: host.ChatSessionDto | null = null;
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.agentTurn).mockImplementation(
      async (id, _text, _forceLocal, model, provider, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "tool",
            payload: {
              id: "search-provider-failure",
              name: "search_logs",
              summary: "1 matching log event",
              ok: true,
            },
          },
          {
            kind: "error",
            payload: {
              code: "linked_synthesis_provider_error",
              message:
                "The provider failed after retrieval; governed evidence is preserved.",
            },
          },
          {
            kind: "turn_completed",
            payload: { reason: "linked_synthesis_provider_error" },
          },
          {
            kind: "linked_synthesis_retry",
            payload: {
              available: true,
              session_id: id,
              corpus_id: "c1",
              provider_profile_id: provider,
              model_id: model,
            },
          },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "Preserve this exact question" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    expect(await screen.findByTestId("retry-linked-synthesis")).toBeTruthy();
    expect(screen.queryByTestId("linked-evidence-trust-disclosure")).toBeNull();
    await waitFor(() => {
      const saved = stored;
      expect(
        saved?.messages.some(
          (message) =>
            message.role === "user" &&
            message.content === "Preserve this exact question",
        ),
      ).toBe(true);
      expect(
        saved?.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.includes("governed evidence is preserved"),
        ),
      ).toBe(true);
    });
  });

  it("jump-to-latest restores follow mode after deliberate upward scroll", async () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Row ${i}`,
    }));
    const stored = sessionDto("s-jump", "Jump chat", history);
    vi.mocked(host.hostSaveChatSession).mockResolvedValue(stored);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: stored.id,
        title: stored.title,
        archived: false,
        pinned: false,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: history.length,
        preview: "Row 19",
        linked_corpus_id: "c1",
      },
    ]);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Jump chat"),
    );
    const thread = await screen.findByTestId("log-explorer-chat-thread");
    await within(thread).findByText("Row 19");

    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      value: 1800,
    });
    Object.defineProperty(thread, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      writable: true,
      value: 10,
    });
    fireEvent.scroll(thread);

    const jump = await screen.findByTestId("linked-chat-jump-latest");
    expect(jump.textContent).toBe("Jump to latest");
    // Keyboard-accessible control.
    jump.focus();
    expect(document.activeElement).toBe(jump);
    fireEvent.click(jump);
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-jump-latest")).toBeNull(),
    );
  });

  it("rejects wrong-corpus nav chips fail-closed", async () => {
    const onApplyNav = vi.fn();
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _t, _f, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "text_delta",
            payload: {
              text: 'See {"type":"log_nav","corpusId":"other","sources":["x.log"],"label":"Other corpus"}',
            },
          },
          { kind: "turn_completed", payload: {} },
        ];
        for (const e of events) onEvent?.(e);
        return events;
      },
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={onApplyNav}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "nav please" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    const chip = await screen.findByTestId("linked-chat-nav-chip");
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    expect(onApplyNav).not.toHaveBeenCalled();
  });

  it("does not permanently expose raw viewBrief dump", async () => {
    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        developerMode={false}
      />,
    );
    expect(screen.queryByTestId("log-explorer-view-context")).toBeNull();
    expect(screen.getByTestId("linked-chat-agent-context")).toBeTruthy();
    expect(screen.queryByLabelText("Paste log_nav JSON")).toBeNull();
  });

  it("shouldApplyChatLoad rejects stale generations and mismatched ids", () => {
    expect(shouldApplyChatLoad(2, 2, "b", "b")).toBe(true);
    expect(shouldApplyChatLoad(1, 2, "a", "b")).toBe(false);
    expect(shouldApplyChatLoad(2, 2, "a", "b")).toBe(false);
    expect(shouldApplyChatLoad(3, 3, "b", null)).toBe(false);
  });

  it("late openChat for A cannot overwrite active chat B", async () => {
    const chatA = sessionDto("a", "Chat A", [
      { id: "a1", role: "user", content: "message-from-A-only" },
    ]);
    const chatB = sessionDto("b", "Chat B", [
      { id: "b1", role: "user", content: "message-from-B-only" },
    ]);
    const resolvers = new Map<
      string,
      (value: host.ChatSessionDto | null) => void
    >();
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "a",
        title: "Chat A",
        archived: false,
        pinned: false,
        created_at: chatA.created_at,
        updated_at: chatA.updated_at,
        message_count: 1,
        preview: "A",
        linked_corpus_id: "c1",
      },
      {
        id: "b",
        title: "Chat B",
        archived: false,
        pinned: false,
        created_at: chatB.created_at,
        updated_at: chatB.updated_at,
        message_count: 1,
        preview: "B",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      (id) =>
        new Promise((resolve) => {
          resolvers.set(id, resolve);
        }),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    // Request A, then B before A resolves.
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat B"),
    );

    // B resolves first.
    await act(async () => {
      resolvers.get("b")?.(chatB);
    });
    await waitFor(() =>
      expect(screen.getByText("message-from-B-only")).toBeTruthy(),
    );
    expect(screen.queryByText("message-from-A-only")).toBeNull();

    // A resolves later — must not clobber B.
    await act(async () => {
      resolvers.get("a")?.(chatA);
    });
    // Allow microtasks to flush any stale setters.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("message-from-B-only")).toBeTruthy();
    expect(screen.queryByText("message-from-A-only")).toBeNull();
    expect(screen.getByTestId("linked-chat-header").textContent).toMatch(
      /Chat B/,
    );
  });

  it("late openChat error for A does not clear active chat B", async () => {
    const chatB = sessionDto("b", "Chat B", [
      { id: "b1", role: "assistant", content: "stable-B-content" },
    ]);
    const resolvers = new Map<
      string,
      {
        resolve: (value: host.ChatSessionDto | null) => void;
        reject: (err: Error) => void;
      }
    >();
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "a",
        title: "Chat A",
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
      {
        id: "b",
        title: "Chat B",
        archived: false,
        pinned: false,
        created_at: chatB.created_at,
        updated_at: chatB.updated_at,
        message_count: 1,
        preview: "B",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      (id) =>
        new Promise((resolve, reject) => {
          resolvers.set(id, { resolve, reject });
        }),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat B"),
    );
    await act(async () => {
      resolvers.get("b")?.resolve(chatB);
    });
    await waitFor(() =>
      expect(screen.getByText("stable-B-content")).toBeTruthy(),
    );
    await act(async () => {
      resolvers.get("a")?.reject(new Error("load-A-failed"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("stable-B-content")).toBeTruthy();
    expect(screen.queryByText(/load-A-failed/)).toBeNull();
  });

  it("keeps pending turn status, errors, and navigation scoped to the originating chat", async () => {
    const sessions = new Map([
      ["a", sessionDto("a", "Chat A")],
      ["b", sessionDto("b", "Chat B")],
    ]);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(async () =>
      [...sessions.values()].map((s) => ({
        id: s.id,
        title: s.title,
        archived: false,
        pinned: false,
        created_at: s.created_at,
        updated_at: s.updated_at,
        message_count: s.messages.length,
        preview: s.messages.at(-1)?.content ?? "",
        linked_corpus_id: "c1",
      })),
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      async (id) => sessions.get(id) ?? null,
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (dto) => {
      sessions.set(dto.id, dto);
      return dto;
    });

    let resolveA: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (id, _text, _fl, _m, _p, onEvent) => {
        if (id === "a") {
          return new Promise((resolve) => {
            resolveA = (events) => {
              for (const event of events) onEvent?.(event);
              resolve(events);
            };
          });
        }
        const events: host.EventDto[] = [
          { kind: "text_delta", payload: { text: "B completed normally." } },
          { kind: "turn_completed", payload: {} },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    const openNamedChat = async (name: string) => {
      fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
      fireEvent.click(
        within(screen.getByTestId("linked-chat-switcher")).getByText(name),
      );
    };

    await openNamedChat("Chat A");
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "investigate A" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await waitFor(() =>
      expect(screen.getByTestId("send-linked-chat").textContent).toMatch(
        /Stop/,
      ),
    );

    // Switching to B must expose B's independent composer while A is pending.
    await openNamedChat("Chat B");
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).disabled,
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "investigate B" },
    });
    expect(
      (screen.getByTestId("send-linked-chat") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await screen.findByText("B completed normally.");
    await screen.findByText("Linked chat response saved");

    // A completes later with an A-only navigation proposal. B must not show it.
    await act(async () => {
      resolveA?.([
        {
          kind: "text_delta",
          payload: {
            text: 'A evidence {"type":"log_nav","corpusId":"c1","sources":["a.log"],"label":"A-only nav"}',
          },
        },
        {
          kind: "citation",
          payload: {
            source_id: "log_template:chat-a-only",
            label: "chat-a-only",
          },
        },
        { kind: "turn_completed", payload: {} },
      ]);
    });
    expect(screen.queryByText("A-only nav")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sources" })).toBeNull();
    await screen.findByText("Linked chat response saved");

    await openNamedChat("Chat A");
    expect(await screen.findByText(/A evidence/)).toBeTruthy();
    expect(screen.getByText("A-only nav")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getAllByText("chat-a-only").length).toBeGreaterThan(0);
    await screen.findByText("Linked chat response saved");
  });

  it("virtualizes long transcripts and keeps pending turns mounted", async () => {
    const history = Array.from({ length: 120 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Long thread row ${i} ${"·".repeat(20)}`,
    }));
    const stored = sessionDto("long", "Long chat", history);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: stored.id,
        title: stored.title,
        archived: false,
        pinned: false,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: history.length,
        preview: "tail",
        linked_corpus_id: "c1",
      },
    ]);

    render(
      <div style={{ height: 480 }}>
        <LinkedChatRail
          corpusId="c1"
          corpusName="fixture"
          agentContext={baseContext}
          onApplyNav={() => undefined}
        />
      </div>,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Long chat"),
    );
    const transcript = await screen.findByTestId("linked-chat-transcript");
    await waitFor(() =>
      expect(transcript.getAttribute("data-message-count")).toBe("120"),
    );
    expect(transcript.getAttribute("data-virtualized")).toBe("true");
    const mounted = Number(transcript.getAttribute("data-mounted-count"));
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(120);
    // Last row (pending/latest) remains force-mounted by the window policy.
    expect(screen.getByText(/Long thread row 119/)).toBeTruthy();
    // Early rows outside the window are not all mounted.
    const earlyMatches = screen.queryAllByText(/Long thread row 0 /);
    // Depending on scroll position, row 0 may or may not be in the overscan;
    // the key proof is mounted < total.
    expect(mounted + earlyMatches.length).toBeLessThanOrEqual(120);
  });

  it("switcher supports Escape dismissal and keyboard option focus", async () => {
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "k1",
        title: "Keyboard one",
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
      {
        id: "k2",
        title: "Keyboard two",
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(null);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    const toggle = await screen.findByTestId("linked-chat-switcher-toggle");
    fireEvent.click(toggle);
    const switcher = await screen.findByTestId("linked-chat-switcher");
    const options = within(switcher).getAllByRole("option");
    options[0]!.focus();
    fireEvent.keyDown(switcher, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(switcher, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-switcher")).toBeNull(),
    );
    expect(document.activeElement).toBe(toggle);
  });

  it("dismisses the switcher through stopped pointer propagation without stealing focus", async () => {
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([]);

    render(
      <div>
        <LinkedChatRail
          corpusId="c1"
          corpusName="fixture"
          agentContext={baseContext}
          onApplyNav={() => undefined}
        />
        <button onPointerDown={(event) => event.stopPropagation()}>
          Outside destination
        </button>
      </div>,
    );
    const toggle = await screen.findByTestId("linked-chat-switcher-toggle");
    fireEvent.click(toggle);
    expect(await screen.findByTestId("linked-chat-switcher")).toBeTruthy();

    const outside = screen.getByRole("button", {
      name: "Outside destination",
    });
    fireEvent.pointerDown(outside);
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-switcher")).toBeNull(),
    );
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it("coordinates Manage with Chats and dismisses it with topmost focus behavior", async () => {
    const stored = sessionDto("s1", "Incident chat");
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: stored.id,
        title: stored.title,
        archived: stored.archived,
        pinned: stored.pinned,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: stored.messages.length,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(stored);

    render(
      <div>
        <LinkedChatRail
          corpusId="c1"
          corpusName="fixture"
          agentContext={baseContext}
          onApplyNav={() => undefined}
        />
        <button onPointerDown={(event) => event.stopPropagation()}>
          Outside Manage destination
        </button>
      </div>,
    );

    const chatsToggle = await screen.findByTestId(
      "linked-chat-switcher-toggle",
    );
    fireEvent.click(chatsToggle);
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Incident chat",
      ),
    );

    const manageToggle = await screen.findByTestId("linked-chat-manage-toggle");
    fireEvent.click(manageToggle);
    let manage = await screen.findByTestId("linked-chat-manage");
    const titleInput = within(manage).getByLabelText("Chat title");
    await waitFor(() => expect(document.activeElement).toBe(titleInput));
    fireEvent.pointerDown(titleInput);
    expect(screen.getByTestId("linked-chat-manage")).toBeTruthy();

    fireEvent.click(chatsToggle);
    expect(screen.queryByTestId("linked-chat-manage")).toBeNull();
    expect(screen.getByTestId("linked-chat-switcher")).toBeTruthy();

    fireEvent.click(manageToggle);
    expect(screen.queryByTestId("linked-chat-switcher")).toBeNull();
    manage = await screen.findByTestId("linked-chat-manage");
    fireEvent.keyDown(within(manage).getByLabelText("Chat title"), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-manage")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(manageToggle));

    fireEvent.click(manageToggle);
    await screen.findByTestId("linked-chat-manage");
    const outside = screen.getByRole("button", {
      name: "Outside Manage destination",
    });
    fireEvent.pointerDown(outside);
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-manage")).toBeNull(),
    );
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it("scopes drafts per chat when switching", async () => {
    const a = sessionDto("a", "Chat A");
    const b = sessionDto("b", "Chat B");
    const store = new Map([
      ["a", a],
      ["b", b],
    ]);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "a",
        title: "Chat A",
        archived: false,
        pinned: false,
        created_at: a.created_at,
        updated_at: a.updated_at,
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
      {
        id: "b",
        title: "Chat B",
        archived: false,
        pinned: false,
        created_at: b.created_at,
        updated_at: b.updated_at,
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      async (id) => store.get(id) ?? null,
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "draft for A" },
    });
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat B"),
    );
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).value,
    ).toBe("");
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).value,
    ).toBe("draft for A");
  });

  it("strips machine log_nav JSON from transcript and shows a single chip", async () => {
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _t, _f, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "text_delta",
            payload: {
              text: 'Here is the finding. {"type":"log_nav","corpusId":"c1","sources":["api.log"],"label":"Focus api"} End note.',
            },
          },
          { kind: "turn_completed", payload: {} },
        ];
        for (const e of events) onEvent?.(e);
        return events;
      },
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "nav please" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await screen.findByTestId("linked-chat-nav-chip");
    expect(screen.getByText(/Here is the finding/)).toBeTruthy();
    expect(screen.getByText(/End note/)).toBeTruthy();
    expect(screen.queryByText(/"type":"log_nav"/)).toBeNull();
    expect(screen.getAllByTestId("linked-chat-nav-chip")).toHaveLength(1);
    expect(screen.getByText("Focus api")).toBeTruthy();
  });

  it("shows quiet unreadable message for malformed navigation-like output", async () => {
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _t, _f, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "text_delta",
            payload: {
              text: 'Broken {"type":"log_nav","corpusId":"c1","sources":[',
            },
          },
          { kind: "turn_completed", payload: {} },
        ];
        for (const e of events) onEvent?.(e);
        return events;
      },
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "nav" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await screen.findByTestId("linked-chat-nav-unreadable");
    expect(
      screen.getByText("Navigation proposal could not be read."),
    ).toBeTruthy();
    expect(screen.queryByText(/"type":"log_nav"/)).toBeNull();
    expect(screen.queryByTestId("linked-chat-nav-chip")).toBeNull();
  });

  it("shows host phase with elapsed time and keeps SR free of tick spam", async () => {
    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        }),
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "slow" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await screen.findByRole("button", { name: /Stop/ });
    // Drive host phase through the real onEvent callback captured by agentTurn.
    const onEvent = vi.mocked(host.agentTurn).mock.calls[0]?.[5] as
      | ((ev: host.EventDto) => void)
      | undefined;
    expect(onEvent).toEqual(expect.any(Function));
    await act(async () => {
      onEvent?.({
        kind: "turn_progress",
        payload: {
          category: "phase",
          stage: "choosing_evidence",
          phase: "started",
          label: "Choosing bounded evidence",
          elapsed_ms: 120,
        },
      });
    });
    expect(screen.getByTestId("linked-chat-phase")).toBeTruthy();
    expect(
      screen.getByRole("status").textContent,
    ).toMatch(/Choosing bounded evidence/);
    const elapsed = screen.getByTestId("linked-chat-elapsed");
    expect(elapsed.getAttribute("aria-hidden")).toBe("true");
    expect(elapsed.textContent).toMatch(/\d/);
    await act(async () => {
      onEvent?.({
        kind: "turn_progress",
        payload: {
          category: "multi_model",
          stage: "reviewer",
          phase: "started",
          label: "Reviewing candidate findings",
          detail: "reviewing 2 candidate findings",
          candidate_id: "opaque-candidate-7",
          elapsed_ms: 980,
        },
      });
    });
    expect(screen.getByRole("status").textContent).toMatch(
      /Reviewing candidate findings/,
    );
    const timeline = screen.getByTestId("turn-progress-timeline");
    expect(within(timeline).getByText("Choosing bounded evidence")).toBeTruthy();
    expect(within(timeline).getByText("Reviewing candidate findings")).toBeTruthy();
    const candidate = within(timeline).getByText("opaque-candidate-7");
    expect(candidate.closest("details")?.hasAttribute("open")).toBe(false);
    fireEvent.click(within(timeline).getByText("Diagnostics"));
    expect(candidate.closest("details")?.hasAttribute("open")).toBe(true);
    await act(async () => {
      resolveTurn?.([
        { kind: "text_delta", payload: { text: "done." } },
        { kind: "turn_completed", payload: {} },
      ]);
    });
  });

  it("shows deterministic broad-triage preparation and bounded completion", async () => {
    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        }),
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    const { container } = render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "What problems do you see in these logs?" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    const onEvent = vi.mocked(host.agentTurn).mock.calls[0]?.[5] as
      | ((ev: host.EventDto) => void)
      | undefined;

    await act(async () => {
      onEvent?.({
        kind: "tool",
        payload: {
          id: "broad-1",
          name: "broad_log_triage",
          summary: "Preparing deterministic large-corpus triage",
          ok: null,
        },
      });
    });
    expect(
      screen.getByText("Preparing deterministic large-corpus triage"),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-state="running"]')?.getAttribute(
        "aria-busy",
      ),
    ).toBe("true");

    await act(async () => {
      onEvent?.({
        kind: "tool",
        payload: {
          id: "broad-1",
          name: "broad_log_triage",
          summary: "Prepared bounded triage brief · 60 evidence identities",
          detail:
            "Host-computed levels, sources, services, templates, timeline, and correlations are ready for synthesis.",
          ok: true,
        },
      });
    });
    expect(
      screen.getByText("Prepared bounded triage brief · 60 evidence identities"),
    ).toBeTruthy();
    expect(container.querySelector('[data-state="success"]')).toBeTruthy();
    await act(async () => {
      resolveTurn?.([
        {
          kind: "text_delta",
          payload: { text: "Grounded triage completed." },
        },
        { kind: "turn_completed", payload: { reason: "stop" } },
      ]);
    });
  });

  it("marks collapsed rail busy while a turn is in flight", async () => {
    let resolveTurn: ((events: host.EventDto[]) => void) | undefined;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _t, _f, _m, _p, onEvent) =>
        await new Promise<host.EventDto[]>((resolve) => {
          resolveTurn = (events) => {
            for (const e of events) onEvent?.(e);
            resolve(events);
          };
        }),
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    const { rerender } = render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        collapsed={false}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "busy collapse" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await screen.findByRole("button", { name: /Stop/ });
    rerender(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        collapsed
      />,
    );
    const rail = await screen.findByTestId("log-explorer-chat");
    expect(rail.getAttribute("data-collapsed")).toBe("true");
    expect(rail.getAttribute("data-busy")).toBe("true");
    expect(rail.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("linked-chat-collapsed-busy")).toBeTruthy();
    await act(async () => {
      resolveTurn?.([
        { kind: "text_delta", payload: { text: "ok" } },
        { kind: "turn_completed", payload: {} },
      ]);
    });
  });

  it("Stop accessible name states it cancels the current turn", async () => {
    let resolveTurn: ((events: host.EventDto[]) => void) | undefined;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _t, _f, _m, _p, onEvent) =>
        await new Promise<host.EventDto[]>((resolve) => {
          resolveTurn = (events) => {
            for (const e of events) onEvent?.(e);
            resolve(events);
          };
        }),
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "cancel wording" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    const stop = await screen.findByRole("button", {
      name: /Stop — cancel the current turn/i,
    });
    expect((stop as HTMLButtonElement).title.toLowerCase()).toMatch(/cancel/);
    expect(stop.className).toMatch(/stop/);
    await act(async () => {
      resolveTurn?.([
        { kind: "text_delta", payload: { text: "ok" } },
        { kind: "turn_completed", payload: {} },
      ]);
    });
  });

  it("does not flash unreadable while a valid log_nav is still streaming", async () => {
    const { LinkedAssistantBody } = await import("./LinkedChatRail");
    const partial =
      'Finding… {"type":"log_nav","corpusId":"c1","sources":["a.log"],"label":"Partial';
    const { rerender, queryByTestId, getByText } = render(
      <LinkedAssistantBody content={partial} streaming />,
    );
    expect(queryByTestId("linked-chat-nav-unreadable")).toBeNull();
    expect(getByText(/Finding/)).toBeTruthy();
    // Still incomplete nav-like JSON — no polished unreadable flash mid-stream.
    expect(queryByTestId("linked-chat-nav-unreadable")).toBeNull();

    // Completed stream with still-malformed payload → quiet unreadable once.
    rerender(
      <LinkedAssistantBody content={partial} streaming={false} />,
    );
    expect(queryByTestId("linked-chat-nav-unreadable")).toBeTruthy();
    expect(getByText("Navigation proposal could not be read.")).toBeTruthy();

    // Completed stream with closed valid payload → chip path (no unreadable).
    const complete =
      'Finding… {"type":"log_nav","corpusId":"c1","sources":["a.log"],"label":"Done"}';
    rerender(
      <LinkedAssistantBody content={complete} streaming={false} />,
    );
    expect(queryByTestId("linked-chat-nav-unreadable")).toBeNull();
    expect(getByText(/Finding/)).toBeTruthy();
    expect(queryByTestId("linked-chat-nav-unreadable")).toBeNull();
  });

  it("advances elapsed with fake timers without SR live-region ticks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) =>
        new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        }),
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("new-linked-chat"));
    await waitFor(() => expect(host.hostSaveChatSession).toHaveBeenCalled());
    fireEvent.change(await screen.findByLabelText("Chat message"), {
      target: { value: "timer" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await screen.findByRole("button", { name: /Stop/ });
    const onEvent = vi.mocked(host.agentTurn).mock.calls[0]?.[5] as
      | ((ev: host.EventDto) => void)
      | undefined;
    await act(async () => {
      onEvent?.({
        kind: "turn_phase",
        payload: { phase: "retrieving_evidence" },
      });
    });
    const elapsed = screen.getByTestId("linked-chat-elapsed");
    expect(elapsed.getAttribute("aria-hidden")).toBe("true");
    const before = elapsed.textContent ?? "";
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    // Elapsed text may change; live status role must still only hold the phase.
    expect(screen.getByRole("status").textContent).toMatch(
      /Retrieving bounded evidence/,
    );
    expect(screen.getByRole("status").textContent).not.toMatch(/\d+\.\d+s/);
    expect(elapsed.textContent).not.toBe("");
    void before;
    await act(async () => {
      resolveTurn?.([
        { kind: "text_delta", payload: { text: "ok" } },
        { kind: "turn_completed", payload: {} },
      ]);
    });
    vi.useRealTimers();
  });
});

describe("linked-chat per-turn Activity parity", () => {
  it("opens Activity for a cancelled empty assistant turn and never shows streaming", async () => {
    const { buildActivityTurn } = await import("../../lib/activity/adapter");
    const { ActivityDrawer } = await import("../activity/ActivityDrawer");
    const { LinkedChatBubble } = await import("./LinkedChatRail");
    const { saveActivityMode } = await import("../../lib/activity/prefs");

    saveActivityMode("drawer");

    const cancelledRecord = {
      version: 1,
      turn_id: "linked-chat::asst-1",
      session_id: "linked-chat",
      message_id: "asst-1",
      scope: { kind: "conversation" as const, label: "Conversation" },
      status: "cancelled" as const,
      total_elapsed_ms: 41027,
      detail_level: "summary" as const,
      dropped_events: 0,
      events: [],
    };
    // Stale streaming:true + empty content + host cancelled — packaged-GUI bug class.
    const message = {
      id: "asst-1",
      role: "assistant" as const,
      content: "",
      streaming: true,
    };
    const turn = buildActivityTurn(message, { record: cancelledRecord });
    expect(turn.label).toBe("(cancelled)");
    expect(turn.label.toLowerCase()).not.toContain("streaming");
    expect(turn.summary.status).toBe("cancelled");

    const onOpen = vi.fn();
    const { rerender } = render(
      <LinkedChatBubble
        message={message}
        developerMode={false}
        virtualized={false}
        top={0}
        activityMode="drawer"
        activityTurn={turn}
        onOpenActivityDetails={onOpen}
      />,
    );

    // Role chrome must not claim streaming once host terminal status is known.
    expect(screen.getByTestId("linked-chat-msg-assistant").textContent).not.toMatch(
      /streaming/i,
    );
    const details = screen.getByRole("button", {
      name: /Activity details/i,
    });
    fireEvent.click(details);
    expect(onOpen).toHaveBeenCalledWith("asst-1");

    // Open the shared Activity drawer surface with the settled turn.
    rerender(
      <>
        <LinkedChatBubble
          message={message}
          developerMode={false}
          virtualized={false}
          top={0}
          activityMode="drawer"
          activityTurn={turn}
          onOpenActivityDetails={onOpen}
        />
        <ActivityDrawer turn={turn} onClose={vi.fn()} />
      </>,
    );

    const label = screen.getByTestId("activity-turn-label");
    expect(label.textContent).toBe("(cancelled)");
    expect(label.textContent?.toLowerCase()).not.toContain("streaming");
    expect(screen.getByTestId("activity-status-chip").textContent).toBe(
      "cancelled",
    );
    expect(screen.getByTestId("activity-terminal-summary").textContent).toMatch(
      /cancelled/i,
    );
  });
});

describe("linked-chat full-rail Activity (session-scoped host path)", () => {
  const chatId = "linked-activity-chat";
  const asstId = "asst-activity-1";

  function mountRailWithSettledAssistant() {
    const stored = sessionDto(chatId, "Activity parity chat", [
      { id: "u1", role: "user", content: "what failed?" },
      { id: asstId, role: "assistant", content: "" },
    ]);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: stored.id,
        title: stored.title,
        archived: false,
        pinned: false,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: stored.messages.length,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(stored);
    return render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
  }

  beforeEach(() => {
    saveActivityMode("off");
    vi.mocked(turnActivity.fetchTurnActivity).mockReset();
    vi.mocked(turnActivity.fetchTurnActivity).mockResolvedValue(null);
  });

  it("uses ActivityToggle + fetchTurnActivity and updates pending → cancelled without streaming", async () => {
    let hostStatus: "pending" | "cancelled" = "pending";
    vi.mocked(turnActivity.fetchTurnActivity).mockImplementation(
      async (sessionId, messageId) => {
        if (sessionId !== chatId || messageId !== asstId) return null;
        return {
          version: 1,
          turn_id: `${chatId}::${asstId}`,
          session_id: chatId,
          message_id: asstId,
          scope: { kind: "conversation", label: "Conversation" },
          status: hostStatus,
          total_elapsed_ms: 41027,
          detail_level: "summary",
          dropped_events: 0,
          events: [],
        };
      },
    );

    mountRailWithSettledAssistant();

    // Open existing linked chat so messages (and activity fetch) mount.
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Activity parity chat",
      ),
    );
    await screen.findByTestId("linked-chat-msg-assistant");

    // Full rail must expose the shared ActivityToggle (not only corpus ActivityRail).
    const toggle = await screen.findByTestId("activity-toggle-trigger");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));

    await waitFor(() =>
      expect(turnActivity.fetchTurnActivity).toHaveBeenCalledWith(
        chatId,
        asstId,
      ),
    );

    // Compact line present for the assistant; still pending host status.
    await waitFor(() => {
      expect(screen.getByTestId("activity-compact-line")).toBeTruthy();
    });
    expect(
      screen.getByTestId("linked-chat-msg-assistant").textContent,
    ).not.toMatch(/streaming/i);

    // Host settles cancelled; session-scoped bridge refreshes with mergeSettled.
    hostStatus = "cancelled";
    await act(async () => {
      await publishTurnActivityUpdate({ sessionId: chatId });
    });

    await waitFor(() => {
      expect(screen.getByTestId("activity-compact-line").textContent).toMatch(
        /cancelled/i,
      );
    });
    expect(
      screen.getByTestId("linked-chat-msg-assistant").textContent,
    ).not.toMatch(/streaming/i);

    // Open drawer surface via Details on the compact line.
    fireEvent.click(
      within(screen.getByTestId("activity-compact-line")).getByRole("button", {
        name: /Activity details/i,
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("activity-turn-label").textContent).toBe(
        "(cancelled)",
      );
    });
    expect(screen.getByTestId("activity-turn-label").textContent).not.toMatch(
      /streaming/i,
    );
    expect(screen.getByTestId("activity-status-chip").textContent).toBe(
      "cancelled",
    );
  });

  it("ignores late activity_settled updates from a prior chat after switch", async () => {
    const otherChat = "other-linked-chat";
    vi.mocked(turnActivity.fetchTurnActivity).mockImplementation(
      async (sessionId, messageId) => {
        if (messageId !== asstId) return null;
        return {
          version: 1,
          turn_id: `${sessionId}::${asstId}`,
          session_id: sessionId,
          message_id: asstId,
          scope: { kind: "conversation", label: "Conversation" },
          status: sessionId === chatId ? "cancelled" : "ok",
          total_elapsed_ms: 10,
          detail_level: "summary",
          dropped_events: 0,
          events: [],
        };
      },
    );

    const storedA = sessionDto(chatId, "Chat A", [
      { id: asstId, role: "assistant", content: "" },
    ]);
    const storedB = sessionDto(otherChat, "Chat B", [
      { id: asstId, role: "assistant", content: "done" },
    ]);
    const sessions = [
      {
        id: storedA.id,
        title: storedA.title,
        archived: false,
        pinned: false,
        created_at: storedA.created_at,
        updated_at: storedA.updated_at,
        message_count: 1,
        preview: "",
        linked_corpus_id: "c1",
      },
      {
        id: storedB.id,
        title: storedB.title,
        archived: false,
        pinned: false,
        created_at: storedB.created_at,
        updated_at: storedB.updated_at,
        message_count: 1,
        preview: "",
        linked_corpus_id: "c1",
      },
    ];
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue(sessions);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      id === chatId ? storedA : id === otherChat ? storedB : null,
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    // Enable Activity via the full-rail toggle (same control ordinary users use).
    fireEvent.click(await screen.findByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));

    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(await screen.findByTestId("linked-chat-switcher")).getByText(
        "Chat A",
      ),
    );
    await screen.findByTestId("linked-chat-msg-assistant");
    await waitFor(() =>
      expect(turnActivity.fetchTurnActivity).toHaveBeenCalledWith(
        chatId,
        asstId,
      ),
    );

    // Switch away before a late settle for Chat A arrives.
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(await screen.findByTestId("linked-chat-switcher")).getByText(
        "Chat B",
      ),
    );
    await screen.findByText("done");

    const callsForA = () =>
      vi
        .mocked(turnActivity.fetchTurnActivity)
        .mock.calls.filter((c) => c[0] === chatId).length;
    const aCallsAtSwitch = callsForA();

    await act(async () => {
      // Late settle for the prior session must not re-query Chat A while B is active.
      await publishTurnActivityUpdate({ sessionId: chatId });
    });
    // Allow microtasks from the subscriber to flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsForA()).toBe(aCallsAtSwitch);

    // Same-session update for B still refreshes B only.
    await act(async () => {
      await publishTurnActivityUpdate({ sessionId: otherChat });
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(turnActivity.fetchTurnActivity)
          .mock.calls.some((c) => c[0] === otherChat),
      ).toBe(true),
    );
    expect(screen.getByText("done")).toBeTruthy();
    // No drawer opened for Chat A's cancelled title.
    expect(screen.queryByTestId("activity-turn-label")).toBeNull();
  });
});
