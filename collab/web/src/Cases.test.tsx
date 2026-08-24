import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseDiscussion } from "./CaseDiscussion.js";
import { Cases } from "./Cases.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fixtureCases = [
  {
    id: "c1",
    title: "Fixture incident",
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
    render(<Cases roles={["case-lead"]} />);
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
    render(<Cases roles={["case-lead"]} />);
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
    render(<Cases roles={["viewer"]} />);
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
    render(<Cases roles={["contributor"]} />);
    const title = await screen.findByPlaceholderText("New investigation title");
    fireEvent.change(title, { target: { value: "Denied case" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not be created",
    );
    expect(screen.queryByText("permission denied")).toBeNull();
  });
});

describe("focused investigation view", () => {
  it("enters Focus on the Situation picture and returns to the overview without losing filters", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    const search = await screen.findByRole("searchbox", {
      name: "Search investigations by title, ID, participant, or creator",
    });
    fireEvent.change(search, { target: { value: "fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture incident" }));

    expect(await screen.findByRole("heading", { name: "Situation" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Investigation stages" })).toBeTruthy();
    // Only the situation surface is presented.
    expect(screen.queryByRole("heading", { name: "Triage workspace" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Evidence and snapshots" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "War Room" }));
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
  });

  it("routes stages so exactly one work surface is presented, with aria-current", async () => {
    stubCaseFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fixture incident" }));
    await screen.findByRole("heading", { name: "Situation" });

    const stageNav = screen.getByRole("navigation", { name: "Investigation stages" });
    fireEvent.click(within(stageNav).getByRole("button", { name: /Capture/ }));
    expect(await screen.findByRole("heading", { name: "Triage workspace" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Situation" })).toBeNull();
    expect(
      within(stageNav).getByRole("button", { name: /Capture/ }).getAttribute("aria-current"),
    ).toBe("page");

    fireEvent.click(within(stageNav).getByRole("button", { name: /Analyze/ }));
    expect(await screen.findByRole("heading", { name: "Evidence and snapshots" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Run history" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Triage workspace" })).toBeNull();

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
    expect(await screen.findByText(/#1 case_created.*target case-c1/)).toBeTruthy();
    expect(
      await screen.findByRole("option", { name: "Fixture chat assistant (external-tool)" }),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "External run output" }), {
      target: { value: "queue depth is the root cause" },
    });
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
    expect(await screen.findByText(/#2 contribution_created/)).toBeTruthy();
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
    await screen.findByRole("heading", { name: "Triage workspace" });
    expect(screen.queryByRole("option", { name: /New source/ })).toBeNull();
    window.dispatchEvent(new Event("contextdesk:source-catalog-changed"));
    expect(
      await screen.findByRole("option", { name: "New source (external-tool)" }),
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

  it("does not repeat signed-in chrome; authors and composer permissions stay explicit", async () => {
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
                  body: "Kickoff from the scene",
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
    render(
      <Cases
        roles={["case-lead"]}
        participant={{ username: "demo", roles: ["case-lead"] }}
      />,
    );
    const panel = await openDiscussion();
    expect(await within(panel).findByText("Kickoff from the scene")).toBeTruthy();
    expect(within(panel).getByText("erin")).toBeTruthy();
    expect(within(panel).queryByText(/Signed in as/)).toBeNull();
    expect(panel.querySelector(".discussion__context")).toBeNull();
    const form = within(panel).getByRole("form", { name: "Post a discussion message" });
    expect(form.getAttribute("aria-label")).toBe("Post a discussion message");
    const identity = within(form).getByText("Posting as demo (case-lead)");
    expect(identity.classList.contains("sr-only")).toBe(true);
    expect(within(form).getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(within(form).getByRole("combobox", { name: "Message visibility" })).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Post to discussion" })).toBeTruthy();
    expect(within(panel).queryByText(/posting is unavailable/)).toBeNull();
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
    expect(screen.getByText(/2 active on this case now/)).toBeTruthy();
    expect(screen.getByText(/live refresh by polling/)).toBeTruthy();
    expect(screen.getByText(/not realtime chat/)).toBeTruthy();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Discussion messages" })).getByText("dave"),
    ).toBeTruthy();
    const composer = screen.getByRole("form", { name: "Post a discussion message" });
    expect(within(composer).getByText("Posting as alice (contributor)").classList.contains("sr-only")).toBe(
      true,
    );
    expect(within(composer).getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(within(composer).getByRole("combobox", { name: "Message visibility" })).toBeTruthy();
    expect(within(composer).getByRole("button", { name: "Post to discussion" })).toBeTruthy();
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
    render(
      <Cases
        roles={["case-lead"]}
        readOnly
        participant={{ username: "demo", roles: ["case-lead"] }}
      />,
    );
    const panel = await openDiscussion();
    expect(await within(panel).findByText("Recorded during the incident")).toBeTruthy();
    expect(within(panel).getByText("alice")).toBeTruthy();
    expect(within(panel).queryByText(/Signed in as/)).toBeNull();
    expect(panel.querySelector(".discussion__context")).toBeNull();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).queryByRole("form")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Post to discussion" })).toBeNull();
    expect(within(panel).getByText(/posting is unavailable/)).toBeTruthy();
  });

  it("tells a read-limited role how to get posting access", async () => {
    stubCaseFetch();
    render(
      <Cases
        roles={["viewer"]}
        participant={{ username: "demo", roles: ["viewer"] }}
      />,
    );
    const panel = await openDiscussion();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(within(panel).queryByRole("form")).toBeNull();
    expect(within(panel).queryByText(/Signed in as/)).toBeNull();
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
