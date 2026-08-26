import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseDiscussion } from "./CaseDiscussion.js";
import { Cases, activityLabel } from "./Cases.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fixtureCases = [
  {
    id: "c1",
    title: "Fixture incident",
    problemStatement: "Synthetic requests pause while a fixture worker restarts.",
    affectedParties: "Fixture operators",
    impact: "Synthetic requests need manual replay.",
    scope: "One disposable worker group.",
    openQuestions: ["Did the queue stall before the restart?"],
    situationVersion: 0,
    status: "open",
    severity: "high",
    participants: [
      { identityId: "uid-alice", username: "alice" },
      { identityId: "uid-dave", username: "dave" },
    ],
    createdAt: "2026-08-15T10:30:00.000Z",
    createdBy: "uid-alice",
  },
  {
    id: "c2",
    title: "Search indexing",
    status: "monitoring",
    severity: "medium",
  },
];

const ACTIVITY_CASE_ID = "11111111-1111-4111-8111-111111111111";

function stubCaseFetch(options?: {
  cases?: unknown[];
  onRequest?: (url: string, init?: RequestInit) => Promise<unknown> | null;
}) {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const handled = options?.onRequest?.(url, init);
    if (handled) return handled;
    if (url === "/api/cases") {
      return { ok: true, json: async () => ({ cases: options?.cases ?? fixtureCases }) };
    }
    if (url === "/api/catalog/sources") {
      return { ok: true, json: async () => ({ sources: [] }) };
    }
    if (url === "/api/investigation-activity?limit=30") {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    if (url.endsWith("/timeline")) {
      return { ok: true, json: async () => ({ events: [] }) };
    }
    if (url.endsWith("/imports")) {
      return { ok: true, json: async () => ({ runs: [] }) };
    }
    if (url.endsWith("/contributions")) {
      return { ok: true, json: async () => ({ contributions: [] }) };
    }
    if (url.endsWith("/experiments") || url.endsWith("/export/inventory")) {
      return { ok: true, json: async () => ({ experiments: [], items: [] }) };
    }
    if (url.includes("/workbench")) {
      return { ok: true, json: async () => ({ items: [], views: [], bookmarks: [], candidateCount: 0 }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("war room overview", () => {
  it("defaults to the overview and never auto-opens an investigation", async () => {
    const stub = stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    expect(await screen.findByRole("heading", { name: "Operating picture" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fixture incident" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Latest activity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View all investigations" })).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    const requested = stub.mock.calls.map((call) => String(call[0]));
    expect(requested).not.toContain("/api/cases/c1/timeline");
  });

  it("counts investigations by recorded status only", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    await screen.findByRole("button", { name: "Fixture incident" });
    // A <dl> has no implicit list role; query by its accessible label instead.
    const dl = document.querySelector('[aria-label="Investigations by recorded status"]');
    expect(dl).toBeTruthy();
    const text = (dl as HTMLElement).textContent ?? "";
    expect(text).toContain("open");
    expect(text).toContain("monitoring");
    const byStatus = Array.from((dl as HTMLElement).querySelectorAll("div")).map((row) => ({
      label: row.querySelector("dt")?.textContent,
      value: row.querySelector("dd")?.textContent,
    }));
    expect(byStatus).toEqual([
      { label: "open", value: "1" },
      { label: "monitoring", value: "1" },
      { label: "resolved", value: "0" },
      { label: "archived", value: "0" },
    ]);
  });

  it("shows recorded participants, creator, and created time — and nothing invented", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} view="investigations" />);
    await screen.findByRole("button", { name: "Fixture incident" });
    const withFacts = screen.getByRole("button", { name: "Fixture incident" })
      .closest("li") as HTMLElement;
    expect(withFacts.textContent).toContain("by alice");
    expect(withFacts.textContent).toContain("2 participants: alice, dave");
    const withoutFacts = screen.getByRole("button", { name: "Search indexing" })
      .closest("li") as HTMLElement;
    expect(withoutFacts.textContent).not.toContain("Opened");
    expect(withoutFacts.textContent).not.toContain("participant");
  });

  it("filters by search text and by recorded status", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} view="investigations" />);
    const search = await screen.findByRole("searchbox", {
      name: "Search investigations by title, ID, participant, or creator",
    });

    fireEvent.change(search, { target: { value: "alice" } });
    expect(screen.getByRole("button", { name: "Fixture incident" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search indexing" })).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    const filter = screen.getByRole("combobox", { name: "Filter investigations by status" });
    fireEvent.change(filter, { target: { value: "monitoring" } });
    expect(screen.queryByRole("button", { name: "Fixture incident" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search indexing" })).toBeTruthy();

    fireEvent.change(filter, { target: { value: "resolved" } });
    expect(
      screen.getByText("No investigations match the current search or filter."),
    ).toBeTruthy();
  });

  it("does not offer investigation creation to a viewer", async () => {
    stubCaseFetch();
    render(<Cases roles={["viewer"]} view="investigations" />);
    await screen.findByRole("button", { name: "Fixture incident" });
    expect(screen.queryByPlaceholderText("New investigation title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create investigation" })).toBeNull();
  });

  it("surfaces a bounded error when a create is denied", async () => {
    stubCaseFetch({
      cases: [],
      onRequest: (url, init) => {
        if (url === "/api/cases" && (init?.method ?? "GET") === "POST") {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: async () => ({ error: "permission denied" }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["contributor"]} view="investigations" />);
    const title = await screen.findByPlaceholderText("New investigation title");
    fireEvent.change(title, { target: { value: "Denied case" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not be created",
    );
    expect(screen.queryByText("permission denied")).toBeNull();
  });

  it("opens a newly created investigation without falling back to the inventory", async () => {
    let listReads = 0;
    stubCaseFetch({
      cases: [],
      onRequest: (url, init) => {
        const method = init?.method ?? "GET";
        if (url === "/api/cases" && method === "GET") {
          listReads += 1;
          if (listReads === 1) {
            return Promise.resolve({ ok: true, json: async () => ({ cases: [] }) });
          }
          return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
        }
        if (url === "/api/cases" && method === "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: "c-created",
              title: "Newly created investigation",
              status: "open",
              severity: "medium",
            }),
          });
        }
        return null;
      },
    });

    render(<Cases roles={["case-lead"]} view="investigations" />);
    const title = await screen.findByPlaceholderText("New investigation title");
    fireEvent.change(title, { target: { value: "Newly created investigation" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    expect(
      await screen.findByRole("heading", { name: "Newly created investigation" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Investigations" })).toBeNull();
    expect(screen.queryByText("That investigation is not available to your account.")).toBeNull();
  });

  it("captures Situation context when an investigation is created", async () => {
    let submitted: Record<string, unknown> | null = null;
    let created: Record<string, unknown> | null = null;
    stubCaseFetch({
      cases: [],
      onRequest: (url, init) => {
        if (url === "/api/cases" && (init?.method ?? "GET") === "GET" && created) {
          return Promise.resolve({ ok: true, json: async () => ({ cases: [created] }) });
        }
        if (url === "/api/cases" && init?.method === "POST") {
          submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
          created = {
            id: "c-created",
            title: submitted.title,
            status: "open",
            severity: "medium",
            problemStatement: submitted.problemStatement,
            affectedParties: submitted.affectedParties,
            impact: submitted.impact,
            scope: submitted.scope,
            openQuestions: submitted.openQuestions,
          };
          return Promise.resolve({
            ok: true,
            json: async () => created,
          });
        }
        return null;
      },
    });

    render(<Cases roles={["contributor"]} view="investigations" />);
    fireEvent.change(await screen.findByPlaceholderText("New investigation title"), {
      target: { value: "Synthetic worker delay" },
    });
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "Synthetic jobs remain queued after a fixture restart." },
    });
    fireEvent.change(screen.getByLabelText("Affected people or systems"), {
      target: { value: "Fixture operators" },
    });
    fireEvent.change(screen.getByLabelText("Impact"), {
      target: { value: "Synthetic jobs require manual replay." },
    });
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "One disposable worker group." },
    });
    fireEvent.change(screen.getByLabelText("Open questions"), {
      target: { value: "Did lease recovery run?\n\nDoes the queue recover?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    expect(await screen.findByRole("heading", { name: "Synthetic worker delay" })).toBeTruthy();
    expect(submitted).toMatchObject({
      problemStatement: "Synthetic jobs remain queued after a fixture restart.",
      affectedParties: "Fixture operators",
      impact: "Synthetic jobs require manual replay.",
      scope: "One disposable worker group.",
      openQuestions: ["Did lease recovery run?", "Does the queue recover?"],
    });
  });

  it("ignores an older successful inventory response after creating an investigation", async () => {
    let resolveInitialList: ((value: unknown) => void) | undefined;
    const initialList = new Promise((resolve) => {
      resolveInitialList = resolve;
    });
    let listReads = 0;
    stubCaseFetch({
      cases: [],
      onRequest: (url, init) => {
        const method = init?.method ?? "GET";
        if (url === "/api/cases" && method === "GET") {
          listReads += 1;
          if (listReads === 1) return initialList;
          return Promise.resolve({
            ok: true,
            json: async () => ({
              cases: [
                {
                  id: "c-created",
                  title: "Race-safe investigation",
                  status: "open",
                  severity: "medium",
                },
              ],
            }),
          });
        }
        if (url === "/api/cases" && method === "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: "c-created",
              title: "Race-safe investigation",
              status: "open",
              severity: "medium",
            }),
          });
        }
        return null;
      },
    });

    render(<Cases roles={["case-lead"]} view="investigations" />);
    const title = await screen.findByPlaceholderText("New investigation title");
    fireEvent.change(title, { target: { value: "Race-safe investigation" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    expect(await screen.findByRole("heading", { name: "Race-safe investigation" })).toBeTruthy();
    resolveInitialList?.({ ok: true, json: async () => ({ cases: [] }) });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Race-safe investigation" })).toBeTruthy();
      expect(screen.queryByText("That investigation is not available to your account.")).toBeNull();
    });
  });

  it("clears a newly created investigation when the latest inventory refresh loses authorization", async () => {
    let listReads = 0;
    stubCaseFetch({
      cases: [],
      onRequest: (url, init) => {
        const method = init?.method ?? "GET";
        if (url === "/api/cases" && method === "GET") {
          listReads += 1;
          if (listReads === 1) {
            return Promise.resolve({ ok: true, json: async () => ({ cases: [] }) });
          }
          return Promise.resolve({ ok: false, status: 403, json: async () => ({}) });
        }
        if (url === "/api/cases" && method === "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: "c-created",
              title: "Authorization changed",
              status: "open",
              severity: "medium",
            }),
          });
        }
        return null;
      },
    });

    render(<Cases roles={["case-lead"]} view="investigations" />);
    const title = await screen.findByPlaceholderText("New investigation title");
    fireEvent.change(title, { target: { value: "Authorization changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    expect(await screen.findByRole("heading", { name: "Investigation unavailable" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "That investigation is not available to your account.",
    );
    expect(screen.queryByRole("heading", { name: "Authorization changed" })).toBeNull();
  });

  it("renders an unavailable deep link as a focused error, not the investigation inventory", async () => {
    stubCaseFetch();
    render(
      <Cases
        roles={["case-lead"]}
        view="investigations"
        focusCaseId="c-not-visible"
        onOpenCase={vi.fn()}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That investigation is not available to your account.");
    expect(screen.getByRole("heading", { name: "Investigation unavailable" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Investigations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fixture incident" })).toBeNull();
  });

  it("shows cross-investigation activity with a direct work-item route", async () => {
    const onActivityOpen = vi.fn();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubCaseFetch({
      onRequest: (url) => {
        if (url === "/api/investigation-activity?limit=30") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: [
                {
                  activityId: "a".repeat(64),
                  occurredAt: "2026-08-24T12:00:00.000Z",
                  actorLabel: "alice",
                  investigationId: ACTIVITY_CASE_ID,
                  investigationTitle: "Fixture incident",
                  summary: "added a discussion comment",
                  resolvedRoute: `/investigations/${ACTIVITY_CASE_ID}/situation?section=discussion&item=message-8&kind=comment#discussion`,
                  provenanceClass: "human",
                  humanFinding: false,
                },
              ],
            }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["case-lead"]} onActivityOpen={onActivityOpen} />);
    const activity = await screen.findByRole("link", {
      name: /alice added a discussion comment Fixture incident/,
    });
    fireEvent.click(activity);
    expect(onActivityOpen).toHaveBeenCalledWith(ACTIVITY_CASE_ID, "situation", {
      section: "discussion",
      item: "message-8",
      itemKind: "comment",
      lane: null,
      experiment: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(
      `http://localhost:3000/investigations/${ACTIVITY_CASE_ID}/situation?section=discussion&item=message-8&kind=comment#discussion`,
    );
    expect(await screen.findByText("Copied.")).toBeTruthy();
  });

  it("keeps the overview bounded when many activities are recorded", async () => {
    stubCaseFetch({
      onRequest: (url) => {
        if (url !== "/api/investigation-activity?limit=30") return null;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: Array.from({ length: 12 }, (_, index) => ({
              activityId: String(index).padStart(64, "a"),
              occurredAt: `2026-08-24T12:${String(index).padStart(2, "0")}:00.000Z`,
              actorLabel: "alice",
              investigationId: ACTIVITY_CASE_ID,
              investigationTitle: "Fixture incident",
              summary: "added a discussion comment",
              resolvedRoute: `/investigations/${ACTIVITY_CASE_ID}/situation?section=discussion&item=message-${index}&kind=comment#discussion`,
              provenanceClass: "human",
              humanFinding: false,
            })),
          }),
        });
      },
    });

    render(<Cases roles={["case-lead"]} />);
    // Twelve distinct records: each opens a different comment, so grouping
    // leaves all twelve and the line counts activities, not raw events.
    await screen.findByText("Showing the 10 most recent of 12 recorded activities.");
    expect(document.querySelectorAll(".activity-feed__item")).toHaveLength(10);
  });
});

describe("operational overview", () => {
  const CASE_A = "11111111-1111-4111-8111-111111111111";
  const CASE_B = "22222222-2222-4222-8222-222222222222";

  function activity(overrides: Record<string, unknown>) {
    return {
      activityId: "a".repeat(64),
      occurredAt: "2026-08-24T12:00:00.000Z",
      actorLabel: "dave",
      investigationId: CASE_A,
      investigationTitle: "Checkout latency spike",
      summary: "updated the investigation",
      resolvedRoute: `/investigations/${CASE_A}/analyze`,
      provenanceClass: "human",
      humanFinding: true,
      privacyVisibility: "member",
      secondaryContext: { label: "Stage", value: "Analyze" },
      ...overrides,
    };
  }

  function stubActivities(items: unknown[]) {
    return stubCaseFetch({
      cases: [
        { id: CASE_A, title: "Checkout latency spike", status: "open", severity: "medium" },
        { id: CASE_B, title: "Index rebuild stall", status: "open", severity: "low" },
      ],
      onRequest: (url) => {
        if (url === "/api/investigation-activity?limit=30") {
          return Promise.resolve({ ok: true, json: async () => ({ items }) });
        }
        return null;
      },
    });
  }

  it("names the stage, provenance, and any restriction on every feed row", async () => {
    stubActivities([
      activity({
        activityId: "1".repeat(64),
        summary: "recorded an observation",
        privacyVisibility: "owner_only",
      }),
      activity({
        activityId: "2".repeat(64),
        summary: "imported analysis was recorded",
        provenanceClass: "ai_generated",
        humanFinding: false,
        secondaryContext: { label: "Stage", value: "Capture" },
      }),
    ]);
    render(<Cases roles={["case-lead"]} />);
    const feed = await screen.findByRole("heading", { name: "Latest activity" });
    const panel = feed.closest("section") as HTMLElement;

    expect(within(panel).getByText("Stage: Analyze")).toBeTruthy();
    expect(within(panel).getByText("Stage: Capture")).toBeTruthy();
    // A human row says so rather than leaving the reader to infer it.
    expect(within(panel).getByText("human-authored")).toBeTruthy();
    expect(within(panel).getByText("AI-assisted · not a human finding")).toBeTruthy();
    expect(within(panel).getByText("private to this case")).toBeTruthy();
  });

  it("keeps restored history in the feed without raising it as open work", async () => {
    stubActivities([
      activity({
        activityId: "7".repeat(64),
        activityKind: "import_recorded",
        summary: "imported analysis was recorded",
        provenanceClass: "historical_restored",
        humanFinding: false,
      }),
      activity({
        activityId: "8".repeat(64),
        activityKind: "workstream_failed",
        summary: "failed a workstream",
        provenanceClass: "historical_restored",
        humanFinding: false,
      }),
    ]);
    render(<Cases roles={["case-lead"]} />);

    // An exact restore replays work that already happened elsewhere. It stays
    // in the feed, where its provenance is stated, but a successful restore
    // must not open a thread for every event it replayed.
    const feed = await screen.findByRole("heading", { name: "Latest activity" });
    const panel = feed.closest("section") as HTMLElement;
    expect(within(panel).getAllByText(/restored history/i).length).toBeGreaterThan(0);
    const threads = await screen.findByRole("complementary", { name: "Open threads" });
    expect(
      within(threads).getByText(
        /Nothing in recent activity is recorded as stopped, disagreeing, unread, or waiting/,
      ),
    ).toBeTruthy();
    expect(within(threads).queryByRole("heading", { name: /Analysis that stopped short/ })).toBeNull();
    expect(
      within(threads).queryByRole("heading", { name: /Imported or AI output not yet read/ }),
    ).toBeNull();
  });

  it("collects stalled, disagreeing, and unread work with a direct path to each", async () => {
    stubActivities([
      activity({
        activityId: "3".repeat(64),
        activityKind: "workstream_failed",
        summary: "failed a workstream",
        provenanceClass: "system",
        humanFinding: false,
        resolvedRoute: `/investigations/${CASE_A}/analyze?section=workstreams`,
      }),
      activity({
        activityId: "4".repeat(64),
        activityKind: "comparison_disagreement",
        investigationId: CASE_B,
        investigationTitle: "Index rebuild stall",
        summary: "recorded a comparison disagreement",
        humanFinding: false,
      }),
      activity({
        activityId: "5".repeat(64),
        activityKind: "import_recorded",
        summary: "imported analysis was recorded",
        provenanceClass: "ai_generated",
        humanFinding: false,
      }),
    ]);
    const onActivityOpen = vi.fn();
    render(<Cases roles={["case-lead"]} onActivityOpen={onActivityOpen} />);
    const threads = await screen.findByRole("complementary", { name: "Open threads" });

    expect(within(threads).getByRole("heading", { name: /Analysis that stopped short/ })).toBeTruthy();
    expect(within(threads).getByRole("heading", { name: /Lanes that disagreed/ })).toBeTruthy();
    expect(
      within(threads).getByRole("heading", { name: /Imported or AI output not yet read/ }),
    ).toBeTruthy();
    // The bound on what was examined is stated, never implied to be everything.
    expect(within(threads).getByText(/most recent recorded events/)).toBeTruthy();

    fireEvent.click(within(threads).getAllByRole("link")[0]!);
    expect(onActivityOpen).toHaveBeenCalledTimes(1);
    expect(onActivityOpen.mock.calls[0]?.[0]).toBe(CASE_A);
  });

  it("lists an investigation whose latest recorded decision is still a proposal", async () => {
    stubActivities([
      // Newest first: case A was accepted after being proposed; case B was not.
      activity({ activityId: "6".repeat(64), activityKind: "decision_accepted", summary: "accepted a decision" }),
      activity({
        activityId: "7".repeat(64),
        activityKind: "decision_proposed",
        investigationId: CASE_B,
        investigationTitle: "Index rebuild stall",
        summary: "proposed a decision",
      }),
      activity({ activityId: "8".repeat(64), activityKind: "decision_proposed", summary: "proposed a decision" }),
    ]);
    render(<Cases roles={["case-lead"]} />);
    const threads = await screen.findByRole("complementary", { name: "Open threads" });
    const pending = within(threads).getByRole("region", { name: /Waiting on a human decision/ });

    expect(within(pending).getByText("Index rebuild stall")).toBeTruthy();
    expect(within(pending).queryByText("Checkout latency spike")).toBeNull();
    expect(within(pending).getByText(/Only a person accepts a decision/)).toBeTruthy();
  });

  it("says plainly when recent activity records nothing open", async () => {
    stubActivities([activity({ activityKind: "observation_recorded" })]);
    render(<Cases roles={["case-lead"]} />);
    const threads = await screen.findByRole("complementary", { name: "Open threads" });
    expect(
      within(threads).getByText(/Nothing in recent activity is recorded as stopped, disagreeing/),
    ).toBeTruthy();
  });

  it("re-reads the projection when a run recorded elsewhere reports a change", async () => {
    let items: unknown[] = [activity({ activityKind: "observation_recorded" })];
    stubCaseFetch({
      cases: [{ id: CASE_A, title: "Checkout latency spike", status: "open", severity: "medium" }],
      onRequest: (url) => {
        if (url === "/api/investigation-activity?limit=30") {
          return Promise.resolve({ ok: true, json: async () => ({ items }) });
        }
        return null;
      },
    });
    render(<Cases roles={["case-lead"]} />);
    await screen.findByRole("heading", { name: "Latest activity" });

    // A workstream finished in Analyze; that work never passed through here.
    items = [
      activity({
        activityId: "b".repeat(64),
        activityKind: "workstream_failed",
        summary: "failed a workstream",
        provenanceClass: "system",
        humanFinding: false,
      }),
      ...items,
    ];
    fireEvent(window, new Event("contextdesk:triage-run-changed"));

    const threads = await screen.findByRole("complementary", { name: "Open threads" });
    await waitFor(() =>
      expect(within(threads).queryByRole("heading", { name: /Analysis that stopped short/ })).toBeTruthy(),
    );
  });

  it("re-reads the projection when the operator returns to the overview", async () => {
    let items: unknown[] = [];
    let activityRequests = 0;
    stubCaseFetch({
      cases: [{ id: CASE_A, title: "Checkout latency spike", status: "open", severity: "medium" }],
      onRequest: (url) => {
        if (url === "/api/investigation-activity?limit=30") {
          activityRequests += 1;
          return Promise.resolve({ ok: true, json: async () => ({ items }) });
        }
        return null;
      },
    });
    const view = render(<Cases roles={["case-lead"]} view="overview" />);
    await screen.findByRole("heading", { name: "Latest activity" });
    const initialRequests = activityRequests;

    // The operator works inside an investigation, where the feed is not shown.
    view.rerender(
      <Cases
        roles={["case-lead"]}
        view="investigations"
        focusCaseId={CASE_A}
        onOpenCase={vi.fn()}
        onStageChange={vi.fn()}
      />,
    );
    items = [activity({ activityId: "c".repeat(64), summary: "recorded an observation" })];

    view.rerender(<Cases roles={["case-lead"]} view="overview" />);
    await waitFor(() => expect(activityRequests).toBeGreaterThan(initialRequests));
    const feed = await screen.findByRole("heading", { name: "Latest activity" });
    const panel = feed.closest("section") as HTMLElement;
    await waitFor(() =>
      expect(within(panel).queryByText(/recorded an observation/)).toBeTruthy(),
    );
  });

  it("shows one imported analysis once, saying how many times it was recorded", async () => {
    // Importing one analysis and then comparing it wrote several entries that
    // said the same thing about the same record. Ten of them filled every slot
    // of Latest activity and pushed the operational story out.
    const importedRoute = `/investigations/${CASE_A}/analyze?item=run-1`;
    const repeated = (id: string, occurredAt: string) => activity({
      activityId: id.repeat(64).slice(0, 64),
      summary: "imported analysis was recorded",
      activityKind: "import_recorded",
      resolvedRoute: importedRoute,
      provenanceClass: "ai_generated",
      humanFinding: false,
      occurredAt,
    });
    stubActivities([
      repeated("1", "2026-08-24T12:02:00.000Z"),
      repeated("2", "2026-08-24T12:01:00.000Z"),
      repeated("3", "2026-08-24T12:00:00.000Z"),
      activity({
        activityId: "4".repeat(64),
        summary: "froze an evidence snapshot",
        activityKind: "evidence_frozen",
        occurredAt: "2026-08-24T11:59:00.000Z",
      }),
    ]);
    render(<Cases roles={["case-lead"]} view="overview" />);

    const feed = await screen.findByRole("heading", { name: "Latest activity" });
    const panel = feed.closest("section") as HTMLElement;
    await waitFor(() =>
      expect(within(panel).getAllByText(/imported analysis was recorded/)).toHaveLength(1),
    );
    // Collapsed, never silently: the row states the repeat.
    expect(within(panel).getByText("recorded 3 times")).toBeTruthy();
    // And the work it was crowding out is still on the page.
    expect(within(panel).getByText(/froze an evidence snapshot/)).toBeTruthy();
  });

  it("does not fold two people's identical work into one row", async () => {
    const importedRoute = `/investigations/${CASE_A}/analyze?item=run-1`;
    stubActivities([
      activity({
        activityId: "1".repeat(64),
        actorLabel: "dave",
        summary: "imported analysis was recorded",
        activityKind: "import_recorded",
        resolvedRoute: importedRoute,
      }),
      activity({
        activityId: "2".repeat(64),
        actorLabel: "erin",
        summary: "imported analysis was recorded",
        activityKind: "import_recorded",
        resolvedRoute: importedRoute,
        occurredAt: "2026-08-24T11:00:00.000Z",
      }),
    ]);
    render(<Cases roles={["case-lead"]} view="overview" />);

    const feed = await screen.findByRole("heading", { name: "Latest activity" });
    const panel = feed.closest("section") as HTMLElement;
    await waitFor(() =>
      expect(within(panel).getAllByText(/imported analysis was recorded/)).toHaveLength(2),
    );
    expect(within(panel).queryByText(/recorded 2 times/)).toBeNull();
  });

  it("says nothing about stage or restriction when the projection omits them", async () => {
    stubActivities([
      {
        activityId: "9".repeat(64),
        occurredAt: "2026-08-24T12:00:00.000Z",
        actorLabel: "dave",
        investigationId: CASE_A,
        investigationTitle: "Checkout latency spike",
        summary: "recorded an observation",
        resolvedRoute: `/investigations/${CASE_A}/capture`,
        provenanceClass: "human",
        humanFinding: true,
      },
    ]);
    render(<Cases roles={["case-lead"]} />);
    const feed = await screen.findByRole("heading", { name: "Latest activity" });
    const panel = feed.closest("section") as HTMLElement;
    expect(within(panel).queryByText(/^Stage:/)).toBeNull();
    expect(within(panel).queryByText(/restricted to its owner/)).toBeNull();
    expect(within(panel).getByText("human-authored")).toBeTruthy();
  });
});

describe("situation briefing", () => {
  /** Records a returning engineer must be able to read without leaving Situation. */
  function briefingFetch() {
    return stubCaseFetch({
      onRequest: (url) => {
        if (url === "/api/cases/c1/timeline") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              events: [
                { seq: 1, kind: "evidence_registered", actorUsername: "alice", targetId: "ev-1", serverTime: "2026-08-24T12:00:00.000Z", payload: "{}" },
                { seq: 2, kind: "evidence_registered", actorUsername: "alice", targetId: "ev-2", serverTime: "2026-08-24T12:01:00.000Z", payload: "{}" },
                { seq: 3, kind: "snapshot_frozen", actorUsername: "alice", targetId: "snap-1", serverTime: "2026-08-24T12:02:00.000Z", payload: "{}" },
              ],
            }),
          });
        }
        if (url === "/api/cases/c1/contributions") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              contributions: [
                {
                  id: "obs-1",
                  kind: "note",
                  body: "Synthetic checkout requests stalled for 9s at the payment step.",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "alice",
                  createdAt: "2026-08-24T12:03:00.000Z",
                },
                {
                  id: "hyp-1",
                  kind: "hypothesis",
                  body: "The synthetic payment pool exhausts after each upstream retry storm.",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "dave",
                  createdAt: "2026-08-24T12:04:00.000Z",
                },
                {
                  id: "act-1",
                  kind: "action",
                  body: "Count distinct synthetic retry attempts per request id in the frozen log.",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "dave",
                  createdAt: "2026-08-24T12:05:00.000Z",
                },
                {
                  id: "gone-1",
                  kind: "hypothesis",
                  body: "Withdrawn synthetic guess that must not appear in the briefing.",
                  privacyClass: "owner_only",
                  tombstoned: true,
                  authorUsername: "dave",
                  createdAt: "2026-08-24T12:06:00.000Z",
                },
                {
                  id: "obs-old",
                  kind: "note",
                  body: "Older synthetic observation from before the queue stabilized.",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "alice",
                  createdAt: "2026-08-24T11:00:00.000Z",
                },
              ],
            }),
          });
        }
        if (url === "/api/cases/c1/imports") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              runs: [
                {
                  id: "run-1",
                  sourceId: "src-1",
                  outputText: "Synthetic assistant claim: queue depth is the root cause.",
                  corroborationState: "unverified",
                  evidenceVisibility: "importer_described",
                  snapshotBinding: null,
                  importerUsername: "dave",
                  operatorUsername: "dave",
                  promptText: null,
                  promptCompleteness: "unknown",
                },
                {
                  id: "run-2",
                  sourceId: "src-1",
                  outputText: "Synthetic assistant claim a person already contradicted.",
                  corroborationState: "contradicted",
                  evidenceVisibility: "importer_described",
                  snapshotBinding: null,
                  importerUsername: "dave",
                  operatorUsername: "dave",
                  promptText: null,
                  promptCompleteness: "unknown",
                },
              ],
            }),
          });
        }
        return null;
      },
    });
  }

  function renderSituation(onDeepNavigate = vi.fn()) {
    render(
      <Cases
        roles={["case-lead"]}
        view="investigations"
        focusCaseId="c1"
        stage="situation"
        onOpenCase={vi.fn()}
        onStageChange={vi.fn()}
        onDeepNavigate={onDeepNavigate}
      />,
    );
    return onDeepNavigate;
  }

  it("leads with what people recorded, not just how many records exist", async () => {
    briefingFetch();
    renderSituation();
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });

    // The engineer reads the substance of each group without leaving Situation.
    expect(
      within(briefing).getByText(/synthetic payment pool exhausts after each upstream retry storm/i),
    ).toBeTruthy();
    expect(
      within(briefing).getByText(/count distinct synthetic retry attempts per request id/i),
    ).toBeTruthy();
    expect(
      within(briefing).getByText(/synthetic checkout requests stalled for 9s at the payment step/i),
    ).toBeTruthy();

    // A hypothesis is never presented as an established cause.
    expect(
      within(briefing).getByText(/a hypothesis is not an established cause/i),
    ).toBeTruthy();
  });

  it("orders each briefing group by recorded time rather than API or UUID order", async () => {
    briefingFetch();
    renderSituation();
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });
    const observations = within(briefing).getByRole("region", { name: /Latest observations/ });
    const entries = within(observations).getAllByRole("listitem");

    expect(entries[0]?.textContent).toContain("stalled for 9s at the payment step");
    expect(entries[1]?.textContent).toContain("Older synthetic observation");
  });

  it("marks a briefing entry whose record is not broadly readable", async () => {
    briefingFetch();
    renderSituation();
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });
    const hypotheses = within(briefing).getByRole("region", { name: /Working hypotheses/ });
    // The fixture records this hypothesis as owner_only.
    expect(within(hypotheses).getByText("private to this case")).toBeTruthy();
    // Imported output stays concise; low-level visibility state is not primary briefing copy.
    const imported = within(briefing).getByRole("region", {
      name: /Imported analysis awaiting a human read/,
    });
    expect(within(imported).getByText("Imported by dave")).toBeTruthy();
    expect(within(imported).queryByText(/importer_described/)).toBeNull();
  });

  it("keeps a removed contribution out of the working record", async () => {
    briefingFetch();
    renderSituation();
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });
    expect(
      within(briefing).queryByText(/withdrawn synthetic guess/i),
    ).toBeNull();
    // One live hypothesis remains; the tombstoned one is not counted either.
    const group = within(briefing).getByRole("region", { name: /Working hypotheses/ });
    expect(within(group).getByText("1 recorded")).toBeTruthy();
  });

  it("separates imported output awaiting a human read and never labels it human-authored", async () => {
    briefingFetch();
    renderSituation();
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });
    const imported = within(briefing).getByRole("region", {
      name: /Imported analysis awaiting a human read/,
    });
    expect(within(imported).getByText(/queue depth is the root cause/i)).toBeTruthy();
    expect(within(imported).getByText("imported · unverified")).toBeTruthy();
    expect(within(imported).queryByText("human-authored")).toBeNull();
    // A run a person already judged is no longer pending.
    expect(within(imported).queryByText(/a person already contradicted/i)).toBeNull();
    expect(within(imported).getByText("1 pending")).toBeTruthy();
  });

  it("restates recorded evidence and opens the board that owns it", async () => {
    briefingFetch();
    const nav = renderSituation(vi.fn());
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });
    expect(within(briefing).getByText(/2 items registered/)).toBeTruthy();
    expect(within(briefing).getByText(/1 snapshot frozen/)).toBeTruthy();
    fireEvent.click(within(briefing).getByRole("button", { name: "Open the evidence board" }));
    expect(nav).toHaveBeenCalledWith("analyze", {
      section: "triage-evidence-board",
      item: null,
      itemKind: null,
      lane: null,
      experiment: null,
    });
  });

  it("opens the exact record a briefing entry names", async () => {
    briefingFetch();
    const nav = renderSituation(vi.fn());
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });
    const hypotheses = within(briefing).getByRole("region", { name: /Working hypotheses/ });
    fireEvent.click(
      within(hypotheses).getByRole("button", { name: "Open where this was recorded" }),
    );
    expect(nav).toHaveBeenCalledWith("capture", {
      section: "triage-capture",
      item: "hyp-1",
      itemKind: "contribution",
      lane: null,
      experiment: null,
    });

    const imported = within(briefing).getByRole("region", {
      name: /Imported analysis awaiting a human read/,
    });
    fireEvent.click(
      within(imported).getByRole("button", { name: "Open to record a human judgment" }),
    );
    expect(nav).toHaveBeenCalledWith("capture", {
      section: "triage-capture",
      item: "run-1",
      itemKind: "imported-run",
      lane: null,
      experiment: null,
    });
  });

  it("states plainly when a group has nothing recorded", async () => {
    stubCaseFetch();
    renderSituation();
    const briefing = await screen.findByRole("region", { name: "Where the investigation stands" });
    expect(within(briefing).getByText("No working hypothesis has been recorded yet.")).toBeTruthy();
    expect(within(briefing).getByText("No next action has been recorded yet.")).toBeTruthy();
    expect(within(briefing).getByText("No external analysis has been imported.")).toBeTruthy();
    expect(
      within(briefing).getByText(/no evidence has been registered on this investigation yet/),
    ).toBeTruthy();
  });
});

describe("focused investigation view", () => {
  it("routes investigation-local activity to its exact typed record item", async () => {
    const onDeepNavigate = vi.fn();
    stubCaseFetch({
      onRequest: (url) => {
        if (url === "/api/cases/c1/timeline") {
          return Promise.resolve({ ok: true, json: async () => ({ events: [{
            seq: 12,
            kind: "contribution_created",
            actorUsername: "alice",
            targetId: "note-12",
            serverTime: "2026-08-24T12:00:00.000Z",
            payload: "{}",
          }] }) });
        }
        if (url === "/api/cases/c1/contributions") {
          return Promise.resolve({ ok: true, json: async () => ({ contributions: [{
            id: "note-12",
            kind: "note",
            body: "Synthetic queue observation",
            privacyClass: "owner_only",
            tombstoned: false,
          }] }) });
        }
        return null;
      },
    });
    render(
      <Cases
        roles={["case-lead"]}
        view="investigations"
        focusCaseId="c1"
        stage="situation"
        onOpenCase={vi.fn()}
        onStageChange={vi.fn()}
        onDeepNavigate={onDeepNavigate}
      />,
    );
    // The row names the kind the person recorded — a note — and the deep link
    // resolves to that same note.
    fireEvent.click(await screen.findByRole("button", { name: /recorded a note alice/ }));
    expect(onDeepNavigate).toHaveBeenCalledWith("capture", {
      section: "triage-capture",
      item: "note-12",
      itemKind: "contribution",
      lane: null,
      experiment: null,
    });
  });

  it("enters Focus on the Situation picture and returns to the inventory without losing filters", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} view="investigations" />);
    const search = await screen.findByRole("searchbox", {
      name: "Search investigations by title, ID, participant, or creator",
    });
    fireEvent.change(search, { target: { value: "fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture incident" }));

    expect(await screen.findByRole("heading", { name: "Situation" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Investigation stages" })).toBeTruthy();
    // Only the situation surface is presented.
    expect(screen.queryByRole("heading", { name: "Capture evidence and observations" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Evidence and snapshots" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Investigations" }));
    const searchAgain = await screen.findByRole("searchbox", {
      name: "Search investigations by title, ID, participant, or creator",
    });
    expect((searchAgain as HTMLInputElement).value).toBe("fixture");
  });

  it("summarises only recorded facts on the Situation picture", async () => {
    stubCaseFetch({
      onRequest: (url) => {
        if (url === "/api/cases/c1/timeline") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              events: [
                {
                  seq: 1,
                  kind: "case_created",
                  actorUsername: "alice",
                  serverTime: "2026-08-15T00:00:00.000Z",
                  payload: "{}",
                },
              ],
            }),
          });
        }
        if (url === "/api/cases/c1/contributions") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              contributions: [
                { id: "n1", kind: "note", body: "x", privacyClass: "owner_only", tombstoned: false },
                { id: "n2", kind: "note", body: "y", privacyClass: "owner_only", tombstoned: true },
              ],
            }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    const activity = await screen.findByRole("region", { name: "Recorded activity" });
    expect(within(activity).getByText("1 timeline event")).toBeTruthy();
    expect(within(activity).getByText("1 recorded contribution")).toBeTruthy();
    expect(within(activity).getByText("0 imported external runs")).toBeTruthy();
    const facts = document.querySelector(".situation__facts") as HTMLElement;
    expect(facts.textContent).toContain("alice, dave");
    expect(facts.textContent).toContain("by alice");
    const situation = screen.getByRole("region", { name: "Recorded context" });
    expect(situation.textContent).toContain(
      "Synthetic requests pause while a fixture worker restarts.",
    );
    expect(situation.textContent).toContain("Fixture operators");
    expect(situation.textContent).toContain("Did the queue stall before the restart?");
  });

  it("lets an authorized member edit Situation context and keeps viewers read-only", async () => {
    let current = { ...fixtureCases[0]!, situationVersion: 0 };
    const fetchStub = stubCaseFetch({
      cases: [current],
      onRequest: (url, init) => {
        if (url === "/api/cases") {
          return Promise.resolve({ ok: true, json: async () => ({ cases: [current] }) });
        }
        if (url === "/api/cases/c1/situation" && init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
          current = {
            ...current,
            problemStatement: patch.problemStatement as string,
            affectedParties: patch.affectedParties as string,
            impact: patch.impact as string,
            scope: patch.scope as string,
            openQuestions: patch.openQuestions as string[],
            situationVersion: current.situationVersion + 1,
          };
          return Promise.resolve({ ok: true, json: async () => current });
        }
        return null;
      },
    });
    const { unmount } = render(<Cases roles={["contributor"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit situation" }));
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "Synthetic queue pressure continues after restart." },
    });
    fireEvent.change(screen.getByLabelText("Open questions"), {
      target: { value: "Did the worker reclaim its lease?\nIs backlog still increasing?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save situation" }));

    await screen.findByText("Synthetic queue pressure continues after restart.");
    expect(screen.getByText("Did the worker reclaim its lease?")).toBeTruthy();
    const patchCall = fetchStub.mock.calls.find(
      (call) => String(call[0]) === "/api/cases/c1/situation",
    );
    expect(patchCall?.[1]?.method).toBe("PATCH");
    unmount();

    stubCaseFetch({ cases: [current] });
    render(<Cases roles={["viewer"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    expect(screen.queryByRole("button", { name: "Edit situation" })).toBeNull();
    expect(screen.getByText("Synthetic queue pressure continues after restart.")).toBeTruthy();
  });

  it("preserves a stale draft but requires reloading current Situation context after 409", async () => {
    let current = { ...fixtureCases[0]!, situationVersion: 0 };
    let patchBody: Record<string, unknown> | null = null;
    stubCaseFetch({
      cases: [current],
      onRequest: (url, init) => {
        if (url === "/api/cases") {
          return Promise.resolve({ ok: true, json: async () => ({ cases: [current] }) });
        }
        if (url === "/api/cases/c1/situation" && init?.method === "PATCH") {
          patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          current = {
            ...current,
            problemStatement: "A teammate recorded newer context.",
            situationVersion: 1,
          };
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ error: "situation_conflict", currentVersion: 1 }),
          });
        }
        return null;
      },
    });

    render(<Cases roles={["contributor"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit situation" }));
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "My stale draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save situation" }));

    expect(await screen.findByText(/changed while you were editing/i)).toBeTruthy();
    expect(patchBody).toMatchObject({ expectedVersion: 0, problemStatement: "My stale draft." });
    expect((screen.getByRole("button", { name: "Save situation" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByLabelText("Problem statement") as HTMLTextAreaElement).value)
      .toBe("My stale draft.");

    fireEvent.click(screen.getByRole("button", { name: "Reload latest context" }));
    expect((screen.getByLabelText("Problem statement") as HTMLTextAreaElement).value)
      .toBe("A teammate recorded newer context.");
    expect((screen.getByRole("button", { name: "Save situation" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("shows explicit not-recorded values for older investigations", async () => {
    stubCaseFetch({ cases: [fixtureCases[1]] });
    render(<Cases roles={["case-lead"]} view="investigations" />);
    fireEvent.click(await screen.findByRole("button", { name: "Search indexing" }));
    const situation = screen.getByRole("region", { name: "Recorded context" });
    expect(within(situation).getAllByText("Not recorded")).toHaveLength(4);
    expect(within(situation).getByText("None recorded")).toBeTruthy();
  });

  it("routes stages so exactly one work surface is presented, with aria-current", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    await screen.findByRole("heading", { name: "Situation" });

    const stageNav = screen.getByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Capture/ }));
    expect(await screen.findByRole("heading", { name: "Capture evidence and observations" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Situation" })).toBeNull();
    expect(
      within(stageNav).getByRole("button", { name: /Capture/ }).getAttribute("aria-current"),
    ).toBe("page");

    fireEvent.click(within(stageNav).getByRole("button", { name: /Analyze/ }));
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Run history" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Capture evidence and observations" })).toBeNull();

    fireEvent.click(within(stageNav).getByRole("button", { name: /Compare/ }));
    expect(
      await screen.findByRole("heading", { name: "Experiment lab" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Evidence and snapshots" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Accepted decision" })).toBeNull();

    fireEvent.click(within(stageNav).getByRole("button", { name: /Decide/ }));
    expect(await screen.findByRole("heading", { name: "Decision journal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update status" })).toBeTruthy();
    expect(screen.getByText("Case export tools")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Experiment lab" })).toBeNull();
  });

  it("reviews unresolved log time beside Capture intake and applies only the exact preview", async () => {
    const fingerprint = "a".repeat(64);
    const mutations: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubCaseFetch({
      onRequest: (url, init) => {
        if (url === "/api/cases/c1/log-time" && (init?.method ?? "GET") === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              state: {
                caseId: "c1",
                corpusId: "corpus-c1",
                corpusRevision: 7,
                builtAt: "2026-08-25T12:00:00Z",
                privacyClass: "owner_only",
                sources: [{
                  source: "mailer/offsetless.log",
                  unresolvedLocalRecords: 2,
                  resolvedLocalRecords: 0,
                  explicitWallClockRecords: 0,
                  otherOrderOnlyRecords: 0,
                  declaration: null,
                }],
                reviewOutstanding: true,
                undoableRevision: null,
              },
              dependents: [],
            }),
          });
        }
        if (url === "/api/cases/c1/log-time/preview" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          mutations.push({ url, body });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              corpusRevision: 7,
              declarationFingerprint: fingerprint,
              source: "mailer/offsetless.log",
              ianaTimezone: "America/Chicago",
              affectedRecords: 2,
              existingWallClockRecords: 0,
              unchangedOrderOnlyRecords: 0,
              firstResolvedInstant: "2026-08-25T14:00:00Z",
              lastResolvedInstant: "2026-08-25T14:01:00Z",
              dstGapCount: 0,
              dstFoldCount: 0,
              unsupportedTimestampCount: 0,
              zoneAbbreviationMismatchCount: 0,
              outOfRangeCount: 0,
              samples: [],
            }),
          });
        }
        if (url === "/api/cases/c1/log-time/apply" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          mutations.push({ url, body });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ schemaId: "cd-collab.log_time_outcome.v1" }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));

    const stageNav = screen.getByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Capture/ }));
    const capture = screen.getByRole("region", { name: "Capture" });
    const review = await within(capture).findByRole("region", { name: "Timezone review" });
    const intakeHeading = within(capture).getByRole("heading", {
      name: "Logs and files for this investigation",
    });

    expect(
      (intakeHeading.closest("section") as HTMLElement).compareDocumentPosition(review)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(review.textContent).toContain(
      "One log file records a clock time but not which timezone it was in.",
    );
    expect(review.textContent).toContain(
      "Until someone says which zone each was written in, those lines stay in file order and carry no exact time. ContextDesk will not guess.",
    );
    expect(mutations).toEqual([]);

    fireEvent.click(within(review).getByRole("button", { name: "Declare a timezone" }));
    const zone = within(review).getByLabelText("Which timezone was this file written in?");
    expect((zone as HTMLInputElement).value).toBe("");
    expect(
      within(review).getByRole("button", { name: "Show me what this would do" }),
    ).toHaveProperty("disabled", true);

    fireEvent.change(zone, { target: { value: "America/Chicago" } });
    fireEvent.click(within(review).getByRole("button", { name: "Show me what this would do" }));
    expect(
      await within(review).findByRole("group", { name: "Preview of this timezone" }),
    ).toBeTruthy();
    expect(mutations).toEqual([{
      url: "/api/cases/c1/log-time/preview",
      body: {
        schemaId: "cd-collab.log_time_preview_request.v1",
        source: "mailer/offsetless.log",
        ianaTimezone: "America/Chicago",
        expectedRevision: 7,
      },
    }]);

    fireEvent.click(
      within(review).getByRole("button", {
        name: "Apply America/Chicago to this file",
      }),
    );
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]?.url).toBe("/api/cases/c1/log-time/apply");
    expect(mutations[1]?.body).toEqual({
      schemaId: "cd-collab.log_time_apply_request.v1",
      source: "mailer/offsetless.log",
      ianaTimezone: "America/Chicago",
      expectedRevision: 7,
      declarationFingerprint: fingerprint,
      idempotencyKey: expect.stringMatching(/^logtime-/),
    });

    fireEvent.click(within(stageNav).getByRole("button", { name: /Analyze/ }));
    expect(screen.queryByRole("region", { name: "Timezone review" })).toBeNull();
  });

  it("keeps the stable triage anchors mounted for deep links", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    await screen.findByRole("heading", { name: "Situation" });
    for (const anchor of [
      "#triage-capture",
      "#triage-analyze",
      "#triage-evidence-board",
      "#triage-lane-runner",
      "#triage-compare",
      "#triage-comparison-lab",
      "#triage-decide",
    ]) {
      expect(document.querySelector(anchor), anchor).toBeTruthy();
    }
    const panels = Array.from(document.querySelectorAll(".stage-panel"));
    expect(panels).toHaveLength(5);
    expect(panels.filter((panel) => !panel.hasAttribute("hidden"))).toHaveLength(1);
  });

  it("shows breadcrumbs with aria-current on the active crumb", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs).getByRole("button", { name: "Fixture incident" }).getAttribute(
        "aria-current",
      ),
    ).toBe("page");

    const stageNav = screen.getByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Analyze/ }));
    expect(within(crumbs).getByText("War Room")).toBeTruthy();
    expect(within(crumbs).getByText("Investigations")).toBeTruthy();
    const here = within(crumbs).getByText("Analyze");
    expect(here.getAttribute("aria-current")).toBe("page");
    expect(
      within(crumbs).getByRole("button", { name: "Fixture incident" }).getAttribute(
        "aria-current",
      ),
    ).toBeNull();
  });

  it("wires the breadcrumb through the parent shell when controlled", async () => {
    stubCaseFetch();
    const onExitFocus = vi.fn();
    const onStageChange = vi.fn();
    render(
      <Cases
        roles={["case-lead"]}
        view="investigations"
        focusCaseId="c1"
        stage="analyze"
        onOpenCase={vi.fn()}
        onStageChange={onStageChange}
        onExitFocus={onExitFocus}
      />,
    );
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    fireEvent.click(within(crumbs).getByRole("button", { name: "Investigations" }));
    expect(onExitFocus).toHaveBeenCalledWith("investigations");
    const stageNav = screen.getByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Decide/ }));
    expect(onStageChange).toHaveBeenCalledWith("decide");
  });

  it("opens discussion when a cross-investigation activity deep link targets it", async () => {
    stubCaseFetch();
    render(
      <Cases
        roles={["case-lead"]}
        view="investigations"
        focusCaseId="c1"
        stage="situation"
        focus={{ section: "discussion", item: "message-8", lane: null, experiment: null }}
        onOpenCase={vi.fn()}
      />,
    );

    expect(await screen.findByRole("complementary", { name: "Discussion" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Situation" })).toBeTruthy();
    // The surface opened, and the announcement says exactly that. This fixture
    // renders no such comment, so the page must not claim it opened one — that
    // false success is what made every dead deep link read as a lie.
    expect(await screen.findByText("Opened Discussion.")).toBeTruthy();
    expect(screen.queryByText(/Opened Discussion to the comment/)).toBeNull();
  });

  it("explains a job-level run locator instead of treating it as a missing workstream", async () => {
    stubCaseFetch();
    render(
      <Cases
        roles={["case-lead"]}
        focusCaseId="c1"
        stage="analyze"
        focus={{
          section: "triage-lane-runner",
          item: "run-1",
          itemKind: "triage-run",
          lane: null,
          experiment: null,
        }}
        onOpenCase={() => {}}
        onStageChange={() => {}}
      />,
    );
    // A job-level locator still opens Analyze run history and says so; it is
    // not reported as a missing workstream. The fixture renders no such run,
    // so the announcement stops at the surface rather than claiming the record.
    expect(await screen.findByText("Opened Analyze run history.")).toBeTruthy();
    expect(screen.queryByText(/Opened Analyze run history to the recorded item/)).toBeNull();
    expect(screen.queryByText(/not part of this investigation/)).toBeNull();
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
  });

  it("opens Discussion from a legacy case-discussion locator alias", async () => {
    stubCaseFetch();
    render(
      <Cases
        roles={["case-lead"]}
        view="investigations"
        focusCaseId="c1"
        stage="situation"
        focus={{
          section: "case-discussion",
          item: "message-8",
          itemKind: "comment",
          lane: null,
          experiment: null,
        }}
        onOpenCase={vi.fn()}
      />,
    );

    expect(await screen.findByRole("complementary", { name: "Discussion" })).toBeTruthy();
    // The surface opened, and the announcement says exactly that. This fixture
    // renders no such comment, so the page must not claim it opened one — that
    // false success is what made every dead deep link read as a lie.
    expect(await screen.findByText("Opened Discussion.")).toBeTruthy();
    expect(screen.queryByText(/Opened Discussion to the comment/)).toBeNull();
  });

  it("does not render mutation controls in static read-only mode", async () => {
    stubCaseFetch({
      onRequest: (url) => {
        if (url === "/api/cases/c1/imports") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              runs: [
                {
                  id: "run-1",
                  outputText: "Synthetic output",
                  corroborationState: "unverified",
                  evidenceVisibility: "unknown",
                  snapshotBinding: null,
                  importerUsername: "demo",
                  operatorUsername: "demo",
                  promptText: null,
                  promptCompleteness: "unknown",
                },
              ],
            }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["case-lead"]} readOnly />);
    await screen.findByRole("button", { name: "Fixture incident" });
    expect(screen.queryByPlaceholderText("New investigation title")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Fixture incident" }));
    const stageNav = await screen.findByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Capture/ }));
    expect(await screen.findByText("Unverified imported run")).toBeTruthy();
    for (const text of ["Record human judgment", "Import external run", "Add to timeline"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    fireEvent.click(within(stageNav).getByRole("button", { name: /Decide/ }));
    expect(screen.queryByRole("button", { name: "Update status" })).toBeNull();
    expect(screen.queryByText("Case export tools")).toBeNull();
    expect(
      screen.getByText(/status changes and exports are unavailable/),
    ).toBeTruthy();
  });

  it("reloads imported runs after a delayed import POST on the Capture stage", async () => {
    const events = [
      {
        seq: 1,
        kind: "case_created",
        actorUsername: "alice",
        targetId: "case-c1" as string | null,
        serverTime: "2026-08-15T00:00:00.000Z",
        payload: "{}",
      },
    ];
    let runs: Array<Record<string, unknown>> = [];
    let postedPrivacy: unknown = null;
    stubCaseFetch({
      cases: [fixtureCases[0]],
      onRequest: (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/catalog/sources") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              sources: [{ id: "s1", name: "Fixture chat assistant", kind: "external-tool" }],
            }),
          });
        }
        if (url === "/api/cases/c1/timeline") {
          return Promise.resolve({ ok: true, json: async () => ({ events: [...events] }) });
        }
        if (url === "/api/cases/c1/imports" && method === "GET") {
          return Promise.resolve({ ok: true, json: async () => ({ runs: [...runs] }) });
        }
        if (url === "/api/cases/c1/imports" && method === "POST") {
          return (async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            runs = [
              {
                id: "r1",
                outputText: "queue depth is the root cause",
                corroborationState: "unverified",
                evidenceVisibility: "unknown",
                snapshotBinding: null,
                importerUsername: "alice",
                operatorUsername: "alice",
                promptText: null,
                promptCompleteness: "unknown",
              },
            ];
            return { ok: true, json: async () => ({ id: "r1" }) };
          })();
        }
        if (url === "/api/cases/c1/contributions" && method === "POST") {
          postedPrivacy = JSON.parse(String(init?.body ?? "{}")).privacyClass;
          return (async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            events.push({
              seq: events.length + 1,
              kind: "contribution_created",
              actorUsername: "alice",
              targetId: "n1",
              serverTime: "2026-08-15T00:00:00.000Z",
              payload: '{"kind":"note"}',
            });
            return { ok: true, json: async () => ({ id: "n1" }) };
          })();
        }
        return null;
      },
    });
    render(<Cases roles={["contributor"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    const stageNav = await screen.findByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Capture/ }));
    expect(await screen.findByText("The investigation was opened")).toBeTruthy();
    expect(
      await screen.findByRole("option", { name: "Fixture chat assistant" }),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "External run output" }), {
      target: { value: "queue depth is the root cause" },
    });
    fireEvent.click(screen.getByText("Import details"));
    fireEvent.change(screen.getByRole("textbox", { name: "Operator username" }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Operator identity" }), {
      target: { value: "uid=alice" },
    });
    fireEvent.change(document.querySelector('select[name="sourceId"]') as HTMLSelectElement, {
      target: { value: "s1" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I redacted secrets before save/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import external run" }));
    expect(await screen.findByText("Unverified imported run")).toBeTruthy();

    const noteBody = document.querySelector('textarea[name="body"]') as HTMLTextAreaElement;
    fireEvent.change(noteBody, { target: { value: "On-call observation" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline entry visibility" }), {
      target: { value: "share_safe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));
    expect(await screen.findByText("Case activity was recorded")).toBeTruthy();
    expect(postedPrivacy).toBe("share_safe");
  });

  it("keeps typed import values and shows a bounded error when the import fails", async () => {
    stubCaseFetch({
      cases: [fixtureCases[0]],
      onRequest: (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/catalog/sources") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              sources: [{ id: "s1", name: "Fixture chat assistant", kind: "external-tool" }],
            }),
          });
        }
        if (url === "/api/cases/c1/imports" && method === "POST") {
          return Promise.resolve({
            ok: false,
            status: 422,
            json: async () => ({ error: "importer rejected" }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["contributor"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    const stageNav = await screen.findByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Capture/ }));
    const output = (await screen.findByRole("textbox", {
      name: "External run output",
    })) as HTMLTextAreaElement;
    fireEvent.change(output, { target: { value: "pasted external analysis" } });
    fireEvent.click(screen.getByText("Import details"));
    fireEvent.change(screen.getByRole("textbox", { name: "Operator username" }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Operator identity" }), {
      target: { value: "uid=alice" },
    });
    fireEvent.change(document.querySelector('select[name="sourceId"]') as HTMLSelectElement, {
      target: { value: "s1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import external run" }));

    const alert = await screen.findByText(
      "External run could not be imported. Review the fields and try again.",
    );
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.queryByText("importer rejected")).toBeNull();
    expect(output.value).toBe("pasted external analysis");
  });

  it("refreshes the import source list after a catalog change", async () => {
    let catalogRefreshes = 0;
    stubCaseFetch({
      cases: [fixtureCases[0]],
      onRequest: (url) => {
        if (url === "/api/catalog/sources") {
          catalogRefreshes += 1;
          return Promise.resolve({
            ok: true,
            json: async () => ({
              sources:
                catalogRefreshes > 1
                  ? [{ id: "s1", name: "New source", kind: "external-tool" }]
                  : [],
            }),
          });
        }
        return null;
      },
    });

    render(<Cases roles={["contributor"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    const stageNav = await screen.findByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Capture/ }));
    await screen.findByRole("heading", { name: "Capture evidence and observations" });
    expect(screen.queryByRole("option", { name: /New source/ })).toBeNull();
    window.dispatchEvent(new Event("contextdesk:source-catalog-changed"));
    expect(
      await screen.findByRole("option", { name: "New source" }),
    ).toBeTruthy();
  });
});

describe("case discussion panel", () => {
  async function openDiscussion() {
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    await screen.findByRole("heading", { name: "Situation" });
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    return await screen.findByRole("complementary", { name: "Discussion" });
  }

  it("opens beside the stage, closes on Escape, and returns focus to the control", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    await screen.findByRole("heading", { name: "Situation" });
    const toggle = screen.getByRole("button", { name: "Discussion" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    const panel = await screen.findByRole("complementary", { name: "Discussion" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(panel);
    // The panel accompanies the stage rather than replacing it.
    expect(screen.getByRole("heading", { name: "Situation" })).toBeTruthy();

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Discussion" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    const reopened = await screen.findByRole("complementary", { name: "Discussion" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Close discussion" }));
    expect(screen.queryByRole("complementary", { name: "Discussion" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("lists only durable human messages with recorded author, time, and privacy", async () => {
    stubCaseFetch({
      onRequest: (url, init) => {
        if (url === "/api/cases/c1/contributions" && (init?.method ?? "GET") === "GET") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              contributions: [
                {
                  id: "m1",
                  kind: "message",
                  body: "Failover completed cleanly",
                  privacyClass: "share_safe",
                  tombstoned: false,
                  authorUsername: "alice",
                  createdAt: "2026-08-20T14:05:00.000Z",
                },
                {
                  id: "m2",
                  kind: "message",
                  body: "Withdrawn theory",
                  privacyClass: "owner_only",
                  tombstoned: true,
                  authorUsername: "dave",
                },
                {
                  id: "n1",
                  kind: "note",
                  body: "A capture note",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "alice",
                },
                {
                  id: "x1",
                  kind: "external_run",
                  body: "AI output text",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "alice",
                },
                {
                  id: "m3",
                  kind: "message",
                  body: "Second message without an author",
                  privacyClass: "owner_only",
                  tombstoned: false,
                },
                {
                  id: "m0",
                  kind: "message",
                  body: "Earlier kickoff message",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "erin",
                  createdAt: "2026-08-19T08:00:00.000Z",
                },
              ],
            }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["case-lead"]} />);
    const panel = await openDiscussion();

    expect(await within(panel).findByText("Failover completed cleanly")).toBeTruthy();
    expect(within(panel).getByText("alice")).toBeTruthy();
    expect(within(panel).getAllByText(/2026/).length).toBeGreaterThan(0);
    expect(within(panel).getByText("share-safe")).toBeTruthy();
    expect(within(panel).getByText("Second message without an author")).toBeTruthy();
    expect(within(panel).getByText("Author not recorded")).toBeTruthy();
    expect(within(panel).getAllByText("private to the case").length).toBeGreaterThan(0);
    expect(within(panel).getByText("3 recorded messages")).toBeTruthy();
    // The thread scroller is a named, keyboard-focusable region so the list
    // can be scrolled without a pointer.
    const scroller = within(panel).getByRole("region", { name: "Discussion messages" });
    expect(scroller.getAttribute("tabindex")).toBe("0");
    expect(within(scroller).getByText("Failover completed cleanly")).toBeTruthy();
    // Tombstoned entries, capture notes, and imported AI output never appear
    // in the thread — and nothing labels external output as a human message.
    expect(within(panel).queryByText("Withdrawn theory")).toBeNull();
    expect(within(panel).queryByText("A capture note")).toBeNull();
    expect(within(panel).queryByText("AI output text")).toBeNull();
    // The wire arrives ordered by id; the thread re-sorts by recorded time,
    // keeping messages without a recorded time at the end in wire order.
    const bodies = Array.from(panel.querySelectorAll(".discussion__message-body")).map(
      (node) => node.textContent,
    );
    expect(bodies).toEqual([
      "Earlier kickoff message",
      "Failover completed cleanly",
      "Second message without an author",
    ]);
  });

  it("posts kind=message with the chosen visibility and shows it only after the server confirms", async () => {
    let posted: unknown = null;
    let saved = false;
    stubCaseFetch({
      cases: [fixtureCases[0]],
      onRequest: (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/cases/c1/contributions" && method === "POST") {
          return (async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            posted = JSON.parse(String(init?.body ?? "{}"));
            saved = true;
            return { ok: true, json: async () => ({ id: "m9" }) };
          })();
        }
        if (url === "/api/cases/c1/contributions" && method === "GET") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              contributions: saved
                ? [
                    {
                      id: "m9",
                      kind: "message",
                      body: "Rollback is our fallback",
                      privacyClass: "share_safe",
                      tombstoned: false,
                      authorUsername: "alice",
                      createdAt: "2026-08-21T09:00:00.000Z",
                    },
                  ]
                : [],
            }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["contributor"]} />);
    const panel = await openDiscussion();

    const messageBox = within(panel).getByRole("textbox", { name: "Message" });
    fireEvent.change(messageBox, { target: { value: "Rollback is our fallback" } });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Message visibility" }), {
      target: { value: "share_safe" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Post to discussion" }));
    // Pending is announced and the message is never displayed as durable early.
    // The thread scope matters: the draft legitimately sits in the composer.
    const inThread = { selector: ".discussion__message-body" };
    expect(within(panel).getByText("Saving your message to the case record…")).toBeTruthy();
    expect(within(panel).queryByText("Rollback is our fallback", inThread)).toBeNull();

    expect(await within(panel).findByText("Rollback is our fallback", inThread)).toBeTruthy();
    expect(within(panel).getByText("Message saved to the case record.")).toBeTruthy();
    expect(posted).toEqual({
      kind: "message",
      body: "Rollback is our fallback",
      privacyClass: "share_safe",
    });
    expect((messageBox as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the draft and reports an honest failure, then retries successfully", async () => {
    let attempts = 0;
    let savedBody: string | null = null;
    stubCaseFetch({
      cases: [fixtureCases[0]],
      onRequest: (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/cases/c1/contributions" && method === "POST") {
          attempts += 1;
          if (attempts === 1) {
            return Promise.resolve({
              ok: false,
              status: 403,
              json: async () => ({ error: "denied" }),
            });
          }
          savedBody = String(
            (JSON.parse(String(init?.body ?? "{}")) as { body?: unknown }).body ?? "",
          );
          return Promise.resolve({ ok: true, json: async () => ({ id: "m1" }) });
        }
        if (url === "/api/cases/c1/contributions" && method === "GET") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              contributions: savedBody
                ? [
                    {
                      id: "m1",
                      kind: "message",
                      body: savedBody,
                      privacyClass: "owner_only",
                      tombstoned: false,
                      authorUsername: "dave",
                    },
                  ]
                : [],
            }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["contributor"]} />);
    const panel = await openDiscussion();

    const messageBox = within(panel).getByRole("textbox", {
      name: "Message",
    }) as HTMLTextAreaElement;
    fireEvent.change(messageBox, { target: { value: "Check the failover logs" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Post to discussion" }));

    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("was not saved");
    expect(within(panel).queryByText("denied")).toBeNull();
    expect(messageBox.value).toBe("Check the failover logs");
    // The draft stays in the composer only — nothing shows in the thread.
    const inThread = { selector: ".discussion__message-body" };
    expect(within(panel).queryByText("Check the failover logs", inThread)).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "Post to discussion" }));
    expect(await within(panel).findByText("Check the failover logs", inThread)).toBeTruthy();
    expect(within(panel).getByText("Message saved to the case record.")).toBeTruthy();
  });

  it("shows another user's saved message via bounded polling, labeled as live refresh", async () => {
    let reads = 0;
    const stub = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/contributions") {
        reads += 1;
        return {
          ok: true,
          json: async () => ({
            contributions:
              reads > 1
                ? [
                    {
                      id: "m1",
                      kind: "message",
                      body: "Dave saw a retry storm",
                      privacyClass: "owner_only",
                      tombstoned: false,
                      authorUsername: "dave",
                      createdAt: "2026-08-21T10:00:00.000Z",
                    },
                  ]
                : [],
          }),
        };
      }
      if (url === "/api/cases/c1/presence") {
        return {
          ok: true,
          json: async () => ({
            schemaId: "cd-collab.case_presence.v1",
            caseId: "c1",
            ttlSeconds: 45,
            members: [
              {
                identityId: "u1",
                username: "alice",
                surface: "case_board",
                lastSeenAt: "2026-08-21T10:00:00.000Z",
              },
              {
                identityId: "u2",
                username: "dave",
                surface: "experiment_lab",
                lastSeenAt: "2026-08-21T10:00:05.000Z",
              },
            ],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", stub);
    render(
      <CaseDiscussion
        caseId="c1"
        participant={{ username: "alice", roles: ["contributor"] }}
        canWrite
        readOnly={false}
        onClose={vi.fn()}
        pollIntervalMs={25}
      />,
    );

    expect(await screen.findByText(/No discussion messages yet/)).toBeTruthy();
    expect(await screen.findByText("Dave saw a retry storm")).toBeTruthy();
    expect(screen.getByText("Messages are attributed to your account")).toBeTruthy();
    expect(screen.queryByText(/Signed in as alice/)).toBeNull();
    expect(screen.getByText(/2 active on this case now/)).toBeTruthy();
    expect(screen.getByText(/live refresh by polling/)).toBeTruthy();
    expect(screen.getByText(/not realtime chat/)).toBeTruthy();
    // The panel only reads presence — it never announces a surface of its own.
    const writes = stub.mock.calls.filter(
      (call) => ((call[1] as RequestInit | undefined)?.method ?? "GET") !== "GET",
    );
    expect(writes).toEqual([]);
  });

  it("says presence is unavailable rather than inventing a count", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    const panel = await openDiscussion();
    expect(await within(panel).findByText(/Presence unavailable right now/)).toBeTruthy();
    expect(within(panel).queryByText(/active on this case now/)).toBeNull();
  });

  it("lets a static read-only viewer browse the thread but not post", async () => {
    stubCaseFetch({
      onRequest: (url, init) => {
        if (url === "/api/cases/c1/contributions" && (init?.method ?? "GET") === "GET") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              contributions: [
                {
                  id: "m1",
                  kind: "message",
                  body: "Recorded during the incident",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "alice",
                },
              ],
            }),
          });
        }
        return null;
      },
    });
    render(<Cases roles={["case-lead"]} readOnly />);
    const panel = await openDiscussion();
    expect(await within(panel).findByText("Recorded during the incident")).toBeTruthy();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Post to discussion" })).toBeNull();
    expect(within(panel).getByText(/posting is unavailable/)).toBeTruthy();
  });

  it("tells a read-limited role how to get posting access", async () => {
    stubCaseFetch();
    render(<Cases roles={["viewer"]} />);
    const panel = await openDiscussion();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(
      within(panel).getByText(/Ask a case lead for contributor access/),
    ).toBeTruthy();
  });

  it("persists across stages and stacks through the discussion layout classes", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    const panel = await openDiscussion();

    const work = document.querySelector(".case-view__work") as HTMLElement;
    expect(work.classList.contains("case-view__work--discussing")).toBe(true);
    // Stage content keeps reading order ahead of the complementary panel, so
    // the narrow-screen single-column layout stacks stage first, then panel.
    const stagePanels = work.querySelector(".stage-panels");
    expect(stagePanels).toBeTruthy();
    expect(stagePanels?.nextElementSibling).toBe(panel);
    expect(panel.tagName).toBe("ASIDE");

    const stageNav = screen.getByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Analyze/ }));
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Discussion" })).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Close discussion" }));
    expect(document.querySelector(".case-view__work--discussing")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Discussion" })).toBeNull();
  });

  it("never renders the prior case's thread after the focused case changes", async () => {
    let releaseCaseTwo = () => undefined as void;
    const caseTwoGate = new Promise<void>((resolve) => {
      releaseCaseTwo = resolve;
    });
    const stub = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/contributions") {
        return {
          ok: true,
          json: async () => ({
            contributions: [
              {
                id: "m1",
                kind: "message",
                body: "Case one message",
                privacyClass: "owner_only",
                tombstoned: false,
                authorUsername: "alice",
                createdAt: "2026-08-21T10:00:00.000Z",
              },
            ],
          }),
        };
      }
      if (url === "/api/cases/c2/contributions") {
        await caseTwoGate;
        return {
          ok: true,
          json: async () => ({
            contributions: [
              {
                id: "m2",
                kind: "message",
                body: "Case two message",
                privacyClass: "owner_only",
                tombstoned: false,
                authorUsername: "dave",
                createdAt: "2026-08-21T11:00:00.000Z",
              },
            ],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", stub);
    const { rerender } = render(
      <CaseDiscussion caseId="c1" canWrite readOnly={false} onClose={vi.fn()} pollIntervalMs={60_000} />,
    );
    expect(await screen.findByText("Case one message")).toBeTruthy();

    rerender(
      <CaseDiscussion caseId="c2" canWrite readOnly={false} onClose={vi.fn()} pollIntervalMs={60_000} />,
    );
    // Immediately after the case switch nothing from case one may remain,
    // even though case two is still loading.
    expect(screen.queryByText("Case one message")).toBeNull();
    expect(screen.getByText("Loading the discussion…")).toBeTruthy();

    releaseCaseTwo();
    expect(await screen.findByText("Case two message")).toBeTruthy();
    expect(screen.queryByText("Case one message")).toBeNull();
  });

  it("lets stale contribution and presence responses lose to newer ones", async () => {
    let threadCalls = 0;
    let releaseStaleThread = () => undefined as void;
    const staleThreadGate = new Promise<void>((resolve) => {
      releaseStaleThread = resolve;
    });
    let presenceCalls = 0;
    let releaseStalePresence = () => undefined as void;
    const stalePresenceGate = new Promise<void>((resolve) => {
      releaseStalePresence = resolve;
    });
    const member = (username: string) => ({
      identityId: `u-${username}`,
      username,
      surface: "case_board",
      lastSeenAt: "2026-08-21T10:00:00.000Z",
    });
    const stub = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cases/c1/contributions") {
        threadCalls += 1;
        if (threadCalls === 1) {
          // The oldest request resolves last, after newer ones already applied.
          await staleThreadGate;
          return {
            ok: true,
            json: async () => ({
              contributions: [
                {
                  id: "m0",
                  kind: "message",
                  body: "Stale-only message",
                  privacyClass: "owner_only",
                  tombstoned: false,
                  authorUsername: "alice",
                  createdAt: "2026-08-21T09:00:00.000Z",
                },
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            contributions: [
              {
                id: "m1",
                kind: "message",
                body: "Newer message",
                privacyClass: "owner_only",
                tombstoned: false,
                authorUsername: "dave",
                createdAt: "2026-08-21T10:00:00.000Z",
              },
            ],
          }),
        };
      }
      if (url === "/api/cases/c1/presence") {
        presenceCalls += 1;
        if (presenceCalls === 1) {
          await stalePresenceGate;
          return {
            ok: true,
            json: async () => ({
              schemaId: "cd-collab.case_presence.v1",
              caseId: "c1",
              ttlSeconds: 45,
              members: [member("alice"), member("dave")],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            schemaId: "cd-collab.case_presence.v1",
            caseId: "c1",
            ttlSeconds: 45,
            members: [member("alice")],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", stub);
    render(
      <CaseDiscussion caseId="c1" canWrite readOnly={false} onClose={vi.fn()} pollIntervalMs={25} />,
    );
    expect(await screen.findByText("Newer message")).toBeTruthy();
    expect(await screen.findByText(/1 active on this case now/)).toBeTruthy();

    // Now let the oldest responses land — they must lose, not overwrite.
    releaseStaleThread();
    releaseStalePresence();
    await waitFor(() => expect(threadCalls).toBeGreaterThan(3));
    expect(screen.queryByText("Stale-only message")).toBeNull();
    expect(screen.getByText("Newer message")).toBeTruthy();
    expect(screen.getByText(/1 active on this case now/)).toBeTruthy();
    expect(screen.queryByText(/2 active on this case now/)).toBeNull();
  });

  it("returns the composer to unsaved as soon as a saved or failed outcome is edited", async () => {
    let failNext = false;
    stubCaseFetch({
      cases: [fixtureCases[0]],
      onRequest: (url, init) => {
        if (url === "/api/cases/c1/contributions" && (init?.method ?? "GET").toUpperCase() === "POST") {
          return failNext
            ? Promise.resolve({ ok: false, status: 403, json: async () => ({}) })
            : Promise.resolve({ ok: true, json: async () => ({ id: "m1" }) });
        }
        return null;
      },
    });
    render(<Cases roles={["contributor"]} />);
    const panel = await openDiscussion();
    const messageBox = within(panel).getByRole("textbox", { name: "Message" });

    fireEvent.change(messageBox, { target: { value: "first message" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Post to discussion" }));
    await within(panel).findByText("Message saved to the case record.");
    fireEvent.change(messageBox, { target: { value: "second draft" } });
    expect(within(panel).queryByText("Message saved to the case record.")).toBeNull();

    failNext = true;
    fireEvent.click(within(panel).getByRole("button", { name: "Post to discussion" }));
    await within(panel).findByRole("alert");
    fireEvent.change(messageBox, { target: { value: "second draft, edited" } });
    expect(within(panel).queryByRole("alert")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "Post to discussion" }));
    await within(panel).findByRole("alert");
    fireEvent.change(within(panel).getByRole("combobox", { name: "Message visibility" }), {
      target: { value: "share_safe" },
    });
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("requires an explicit inline discard decision before closing on a dirty draft", async () => {
    stubCaseFetch();
    render(<Cases roles={["contributor"]} />);
    const panel = await openDiscussion();
    const toggle = screen.getByRole("button", { name: "Discussion" });
    const messageBox = within(panel).getByRole("textbox", {
      name: "Message",
    }) as HTMLTextAreaElement;
    fireEvent.change(messageBox, { target: { value: "half-written thought" } });

    // Escape path: close is refused, the inline confirmation takes focus.
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Discussion" })).toBeTruthy();
    const confirmGroup = within(panel).getByRole("group", { name: /has not been posted/ });
    const keepButton = within(confirmGroup).getByRole("button", { name: "Keep editing" });
    expect(document.activeElement).toBe(keepButton);

    // Keep editing cancels: draft intact, focus back in the composer.
    fireEvent.click(keepButton);
    expect(within(panel).queryByRole("group", { name: /has not been posted/ })).toBeNull();
    expect(messageBox.value).toBe("half-written thought");
    expect(document.activeElement).toBe(messageBox);

    // Escape while the confirmation is showing also means keep editing.
    fireEvent.keyDown(panel, { key: "Escape" });
    within(panel).getByRole("group", { name: /has not been posted/ });
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(within(panel).queryByRole("group", { name: /has not been posted/ })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Discussion" })).toBeTruthy();
    expect(document.activeElement).toBe(messageBox);

    // Close-button path: same guard; explicit discard actually closes and
    // only then does focus return to the toggle.
    fireEvent.click(within(panel).getByRole("button", { name: "Close discussion" }));
    const secondGroup = within(panel).getByRole("group", { name: /has not been posted/ });
    fireEvent.click(within(secondGroup).getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByRole("complementary", { name: "Discussion" })).toBeNull();
    expect(document.activeElement).toBe(toggle);

    // Reopening starts from a clean composer — the discard was real.
    fireEvent.click(toggle);
    const reopened = await screen.findByRole("complementary", { name: "Discussion" });
    expect(
      (within(reopened).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("refuses to close while a post is saving, then closes normally after it lands", async () => {
    let resolvePost = () => undefined as void;
    stubCaseFetch({
      cases: [fixtureCases[0]],
      onRequest: (url, init) => {
        if (url === "/api/cases/c1/contributions" && (init?.method ?? "GET").toUpperCase() === "POST") {
          return new Promise((resolve) => {
            resolvePost = () => resolve({ ok: true, json: async () => ({ id: "m1" }) });
          });
        }
        return null;
      },
    });
    render(<Cases roles={["contributor"]} />);
    const panel = await openDiscussion();
    fireEvent.change(within(panel).getByRole("textbox", { name: "Message" }), {
      target: { value: "saving now" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Post to discussion" }));
    expect(within(panel).getByText("Saving your message to the case record…")).toBeTruthy();

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Discussion" })).toBeTruthy();
    expect(within(panel).getByText(/panel stays open until it finishes/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Close discussion" }));
    expect(screen.getByRole("complementary", { name: "Discussion" })).toBeTruthy();

    resolvePost();
    await within(panel).findByText("Message saved to the case record.");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Discussion" })).toBeNull();
  });
});

describe("workstreams in the Analyze stage", () => {
  const workstreamRow = {
    key: "run-1:reviewer-lane",
    caseId: "c1",
    label: "Reviewer workstream — fixture-reviewer-a",
    purpose: "What paused the fixture worker?",
    operatorKind: "ai_assisted",
    operatorLabel: "AI-assisted workstream — output is analysis, never a human finding",
    assignedTo: "alice",
    strategyLabel: "Standard synthetic strategy",
    role: "reviewer",
    inputs: {
      question: "What paused the fixture worker?",
      snapshotLabel: "Frozen evidence set 1",
      snapshotEvidenceCount: 1,
      snapshotFrozenAt: "2026-08-24T06:13:00.000Z",
      sameSnapshot: true,
      snapshotProofLabel: "Ran against the exact frozen evidence set, proven by the host.",
    },
    statusCode: "completed",
    lifecycle: "settled",
    statusLabel: "Completed",
    statusDetail: "Finished and recorded its findings.",
    startedAt: "2026-08-24T06:14:10.000Z",
    finishedAt: "2026-08-24T06:14:25.000Z",
    findings: "The fixture worker restarted while the queue was draining.",
    outcome: "Recorded a written finding; it cited 0 evidence items.",
    evidenceCited: [],
    unknowns: [],
    activity: [
      { at: "2026-08-24T06:14:00.000Z", label: "Run queued", actor: "alice", detail: null },
    ],
    rerun: { isRerun: false, parentKey: null, note: "Not a rerun." },
    agreementNotice: "Agreement is not proof of correctness.",
    technical: {
      workstreamKey: "run-1:reviewer-lane",
      runId: "run-1",
      candidateId: "reviewer-lane",
      snapshotId: "snapshot-1",
      snapshotFingerprint: "f".repeat(64),
      requestFingerprint: "a".repeat(64),
      taskFingerprint: "task-fingerprint",
      strategyId: "contextdesk.standard.synthetic",
      modelId: "fixture-reviewer-a",
      modelVersion: null,
      provider: "synthetic",
      profileId: null,
      outputHash: null,
      benchmarkRunId: null,
      parentRunId: null,
      errorCode: null,
      privacyClass: "share_safe",
    },
  };

  function stubWithWorkstreams() {
    return stubCaseFetch({
      onRequest: (url) => {
        if (url.endsWith("/workstreams")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ caseId: "c1", workstreams: [workstreamRow] }),
          });
        }
        if (url.endsWith("/evidence") || url.endsWith("/snapshots")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ artifacts: [], snapshots: [] }),
          });
        }
        if (url.endsWith("/triage-runs") || url === "/api/triage-profiles" || url === "/api/triage-capabilities") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ jobs: [], profiles: [], syntheticAvailable: true }),
          });
        }
        return null;
      },
    });
  }

  it("lists workstreams beside the evidence board when none is opened", async () => {
    stubWithWorkstreams();
    render(<Cases roles={["case-lead"]} focusCaseId="c1" stage="analyze" onOpenCase={() => {}} onStageChange={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Workstreams" })).toBeTruthy();
    expect(
      await screen.findByRole("link", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
    // The evidence board and the launcher are part of the same stage.
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
  });

  it("makes an opened workstream the stage, not a highlight beside everything else", async () => {
    stubWithWorkstreams();
    render(
      <Cases
        roles={["case-lead"]}
        focusCaseId="c1"
        stage="analyze"
        focus={{
          section: "workstreams",
          item: "run-1:reviewer-lane",
          itemKind: "workstream",
          lane: "run-1:reviewer-lane",
          experiment: null,
        }}
        onOpenCase={() => {}}
        onStageChange={() => {}}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
    expect(screen.getByText("The fixture worker restarted while the queue was draining.")).toBeTruthy();
    await waitFor(() => {
      const board = screen.queryByRole("heading", { name: "Evidence and snapshots" });
      expect(board).toBeNull();
    });
    expect(screen.getByRole("link", { name: "All workstreams" })).toBeTruthy();
  });

  it("gives keyboard focus to the opened workstream, not to a hidden panel", async () => {
    stubWithWorkstreams();
    render(
      <Cases
        roles={["case-lead"]}
        focusCaseId="c1"
        stage="analyze"
        focus={{
          section: "workstreams",
          item: "run-1:reviewer-lane",
          itemKind: "workstream",
          lane: "run-1:reviewer-lane",
          experiment: null,
        }}
        onOpenCase={() => {}}
        onStageChange={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" });
    await waitFor(() => {
      const record = document.querySelector(
        "[data-route-item='run-1:reviewer-lane'][data-route-kind='workstream']",
      );
      expect(document.activeElement).toBe(record);
    });
  });
});

describe("recorded contribution kinds", () => {
  function legacy(kind: string, details: Record<string, unknown>) {
    return {
      caseId: "11111111-1111-4111-8111-111111111111",
      caseTitle: "Checkout latency spike",
      caseStatus: "open",
      caseSeverity: "sev2",
      seq: 1,
      kind,
      actorUsername: "alice",
      targetId: "note-12",
      details,
    } as Parameters<typeof activityLabel>[0];
  }

  // The case record renders a note as "A human note was recorded". The feed
  // called the same target an observation, so following the link showed a
  // record of a different kind than the row that led there.
  it("calls a recorded note a note", () => {
    expect(activityLabel(legacy("contribution_created", { kind: "note" }))).toBe("recorded a note");
  });

  it("never restates a note as an observation or promotes it to a finding", () => {
    const label = activityLabel(legacy("contribution_created", { kind: "note" }));
    expect(label).not.toMatch(/observation/i);
    expect(label).not.toMatch(/finding/i);
  });

  it("leaves the other recorded kinds saying what they are", () => {
    expect(activityLabel(legacy("contribution_created", { kind: "message" }))).toBe("added a discussion comment");
    expect(activityLabel(legacy("contribution_created", { kind: "hypothesis" }))).toBe("proposed a working hypothesis");
    expect(activityLabel(legacy("contribution_created", { kind: "action" }))).toBe("recorded a next action");
    expect(activityLabel(legacy("contribution_created", { kind: "upload" }))).toBe("recorded an evidence upload");
  });
});
