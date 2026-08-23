import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
