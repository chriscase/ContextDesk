/**
 * The record graph inside the investigation workspace. Fixtures are synthetic.
 *
 * The regression this file exists for: an investigation must not be able to
 * reach `resolved` silently. Choosing that status opens the record form and
 * posts nothing until a reason is written, so a case can never end up saying
 * "resolved" with no account of who decided or why.
 *
 * It also pins the manual path that already worked and must keep working: a
 * note, a possible explanation, and a next step are summarised in Situation
 * with no model run anywhere in the case.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cases } from "./Cases.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const investigations = [
  {
    id: CASE_ID,
    title: "Synthetic historical investigation",
    problemStatement: "Synthetic checkout requests timed out during a scheduled batch.",
    affectedParties: "Synthetic operators",
    impact: "Synthetic orders needed manual replay.",
    scope: "One disposable fixture environment.",
    openQuestions: [],
    situationVersion: 0,
    occurredAt: "2024-11-04",
    occurredAtPrecision: "day",
    occurredAtZone: "unspecified",
    status: "open",
    severity: "high",
    participants: [{ identityId: "uid-alice", username: "alice" }],
    createdAt: "2026-08-25T14:02:00.000Z",
    createdBy: "uid-alice",
  },
  {
    id: OTHER_ID,
    title: "Synthetic prior investigation",
    status: "resolved",
    severity: "medium",
  },
];

const contributions = [
  {
    id: "n1",
    // The shipped Situation summary groups `note` under "Latest observations";
    // this fixture uses the kind the workspace actually records.
    kind: "note",
    body: "Pool exhausted during the batch window.",
    revision: 1,
    privacyClass: "owner_only",
    authorUsername: "alice",
    createdAt: "2026-08-25T14:03:00.000Z",
    tombstoned: false,
  },
  {
    id: "h1",
    kind: "hypothesis",
    body: "The scheduled batch and the checkout traffic overlap.",
    revision: 1,
    privacyClass: "owner_only",
    authorUsername: "alice",
    createdAt: "2026-08-25T14:04:00.000Z",
    tombstoned: false,
  },
  {
    id: "a1",
    kind: "action",
    body: "Move the synthetic batch outside the checkout window.",
    revision: 1,
    privacyClass: "owner_only",
    authorUsername: "alice",
    createdAt: "2026-08-25T14:05:00.000Z",
    tombstoned: false,
  },
];

interface Recorded {
  url: string;
  body: unknown;
}

function stubFetch(options?: {
  posted?: Recorded[];
  statusResponse?: (body: unknown) => { ok: boolean; body?: unknown };
  entities?: unknown[];
  involvementIndex?: { investigationId: string; entityId: string }[];
}) {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      const parsed = JSON.parse(String(init.body ?? "{}")) as unknown;
      options?.posted?.push({ url, body: parsed });
      if (url.endsWith("/status") && options?.statusResponse) {
        const outcome = options.statusResponse(parsed);
        return { ok: outcome.ok, json: async () => outcome.body ?? {} };
      }
      return { ok: true, json: async () => ({}) };
    }
    if (url === "/api/cases") {
      return { ok: true, json: async () => ({ cases: investigations }) };
    }
    if (url === "/api/entities") {
      return { ok: true, json: async () => ({ entities: options?.entities ?? [] }) };
    }
    if (url === "/api/involvement/index") {
      return { ok: true, json: async () => ({ entries: options?.involvementIndex ?? [] }) };
    }
    if (url.endsWith("/involvement")) {
      return { ok: true, json: async () => ({ involvements: [] }) };
    }
    if (url.includes("/software-impact/suggestions")) {
      return { ok: true, json: async () => ({ values: [] }) };
    }
    if (url.endsWith("/software-impact")) {
      return { ok: true, json: async () => ({ records: [] }) };
    }
    if (url.endsWith("/references")) {
      return { ok: true, json: async () => ({ outbound: [], inbound: [] }) };
    }
    if (url.endsWith("/contributions")) {
      return { ok: true, json: async () => ({ contributions }) };
    }
    if (url === "/api/catalog/sources") {
      return { ok: true, json: async () => ({ sources: [] }) };
    }
    if (url === "/api/investigation-activity?limit=30") {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({ events: [], items: [], artifacts: [], runs: [] }) };
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

async function openDecideStage() {
  fireEvent.click(await screen.findByRole("button", { name: "Synthetic historical investigation" }));
  await screen.findByRole("heading", { name: "Situation" });
  const stageNav = screen.getByRole("navigation", { name: "Investigation stages" });
  fireEvent.click(within(stageNav).getByRole("button", { name: /Decide/ }));
  await screen.findByRole("heading", { name: "Decision journal" });
}

describe("resolving an investigation", () => {
  it("does not post a resolved status until a reason is recorded", async () => {
    const posted: Recorded[] = [];
    stubFetch({ posted });
    render(<Cases roles={["case-lead"]} />);
    await openDecideStage();

    fireEvent.change(screen.getByLabelText("Case status"), { target: { value: "resolved" } });
    fireEvent.click(screen.getByRole("button", { name: "Update status" }));

    // The record form opens instead, and nothing was sent.
    expect(
      await screen.findByRole("form", { name: "Record why this is resolved" }),
    ).toBeTruthy();
    expect(posted.filter((row) => row.url.endsWith("/status"))).toHaveLength(0);
  });

  it("sends the conclusion and the status together once the reason is written", async () => {
    const posted: Recorded[] = [];
    stubFetch({ posted });
    render(<Cases roles={["case-lead"]} />);
    await openDecideStage();
    fireEvent.change(screen.getByLabelText("Case status"), { target: { value: "resolved" } });
    fireEvent.click(screen.getByRole("button", { name: "Update status" }));
    await screen.findByRole("form", { name: "Record why this is resolved" });

    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "The synthetic batch overlapped the checkout window." },
    });
    fireEvent.change(screen.getByLabelText("Still unknown"), {
      target: { value: "Which change moved the batch." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve with this record" }));

    await waitFor(() =>
      expect(posted.filter((row) => row.url.endsWith("/status"))).toHaveLength(1),
    );
    const sent = posted.find((row) => row.url.endsWith("/status"))?.body as {
      status: string;
      resolution: { basis: string; rationale: string; unknowns: string[] };
    };
    expect(sent.status).toBe("resolved");
    expect(sent.resolution.basis).toBe("human_only");
    expect(sent.resolution.rationale).toContain("checkout window");
    expect(sent.resolution.unknowns).toEqual(["Which change moved the batch."]);
  });

  it("keeps the form open, as a prompt, when the server still refuses", async () => {
    const posted: Recorded[] = [];
    // Stands in for a client whose view of the record went stale: the server
    // is the authority and answers resolution_required even though a
    // resolution was attached. The refusal must read as the form asking for
    // something, not as an unexplained failure.
    stubFetch({
      posted,
      statusResponse: () => ({
        ok: false,
        body: { error: "resolution_required", status: "resolved" },
      }),
    });
    render(<Cases roles={["case-lead"]} />);
    await openDecideStage();
    fireEvent.change(screen.getByLabelText("Case status"), { target: { value: "resolved" } });
    fireEvent.click(screen.getByRole("button", { name: "Update status" }));
    await screen.findByRole("form", { name: "Record why this is resolved" });
    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "Synthetic conclusion." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve with this record" }));

    await waitFor(() =>
      expect(posted.filter((row) => row.url.endsWith("/status"))).toHaveLength(1),
    );
    expect(
      await screen.findByText(/Nothing was changed yet/),
    ).toBeTruthy();
    expect(screen.getByRole("form", { name: "Record why this is resolved" })).toBeTruthy();
  });

  it("explains a concurrent conclusion instead of overwriting it", async () => {
    const posted: Recorded[] = [];
    stubFetch({
      posted,
      statusResponse: () => ({
        ok: false,
        body: { error: "resolution_conflict", currentRevision: 2 },
      }),
    });
    render(<Cases roles={["case-lead"]} />);
    await openDecideStage();
    fireEvent.change(screen.getByLabelText("Case status"), { target: { value: "resolved" } });
    fireEvent.click(screen.getByRole("button", { name: "Update status" }));
    await screen.findByRole("form", { name: "Record why this is resolved" });
    fireEvent.change(screen.getByLabelText("Why"), {
      target: { value: "Synthetic conclusion." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve with this record" }));
    expect(
      await screen.findByText(/Someone else recorded a conclusion while this form was open/),
    ).toBeTruthy();
  });

  it("keeps ordinary monitoring updates on status and excludes archive", async () => {
    const posted: Recorded[] = [];
    stubFetch({ posted });
    render(<Cases roles={["case-lead"]} />);
    await openDecideStage();
    expect(screen.queryByRole("option", { name: "archived" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Case status"), { target: { value: "monitoring" } });
    fireEvent.click(screen.getByRole("button", { name: "Update status" }));
    await waitFor(() =>
      expect(posted.filter((row) => row.url.endsWith("/status"))).toHaveLength(1),
    );
    expect(posted.find((row) => row.url.endsWith("/status"))?.body).toEqual({
      status: "monitoring",
    });
    expect(screen.queryByRole("form", { name: "Record why this is resolved" })).toBeNull();
  });
});

describe("the record panel in Situation", () => {
  it("shows when it happened next to when it was written down", async () => {
    stubFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Synthetic historical investigation" }),
    );
    await screen.findByRole("heading", { name: "Situation" });
    const happened = await screen.findByTestId("occurred-at");
    expect(happened.textContent).toContain("2024-11-04");
    expect(happened.textContent).toContain("time zone not recorded");
    expect(screen.getByTestId("recorded-at").textContent).not.toContain("2024-11-04");
  });

  it("offers other investigations to cite, never this one", async () => {
    stubFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Synthetic historical investigation" }),
    );
    const picker = await screen.findByLabelText("Investigation to cite");
    const options = [...picker.querySelectorAll("option")].map((node) => node.value);
    expect(options).toContain(OTHER_ID);
    expect(options).not.toContain(CASE_ID);
  });
});

describe("creating a historical investigation", () => {
  it("offers a date field that says the time zone is not guessed", async () => {
    stubFetch();
    render(<Cases roles={["case-lead"]} view="investigations" />);
    const field = await screen.findByLabelText("When it happened");
    expect(field).toBeTruthy();
    expect(
      screen.getByText(/the time zone is recorded as not known rather than guessed/i),
    ).toBeTruthy();
  });

  it("sends the typed date with the new investigation", async () => {
    const posted: Recorded[] = [];
    stubFetch({ posted });
    render(<Cases roles={["case-lead"]} view="investigations" />);
    fireEvent.change(await screen.findByLabelText("When it happened"), {
      target: { value: "2024-11-04" },
    });
    fireEvent.change(screen.getByPlaceholderText("New investigation title"), {
      target: { value: "Synthetic backfilled case" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Start a new investigation" }));
    await waitFor(() =>
      expect(posted.filter((row) => row.url === "/api/cases")).toHaveLength(1),
    );
    expect(posted.find((row) => row.url === "/api/cases")?.body).toMatchObject({
      title: "Synthetic backfilled case",
      occurredAt: "2024-11-04",
    });
  });
});

describe("filtering investigations by entity", () => {
  it("offers the filter only once entities exist, and narrows the list", async () => {
    stubFetch({
      entities: [
        {
          id: "e1",
          kind: "organization",
          label: "Fable Harbor",
          profile: null,
          privacyClass: "owner_only",
          lifecycle: "active",
        },
      ],
      involvementIndex: [{ investigationId: CASE_ID, entityId: "e1" }],
    });
    render(<Cases roles={["case-lead"]} view="investigations" />);
    const filter = await screen.findByLabelText("Filter investigations by involved entity");
    expect(screen.getByText("Synthetic prior investigation")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "e1" } });
    await waitFor(() => expect(screen.queryByText("Synthetic prior investigation")).toBeNull());
    expect(screen.getByText("Synthetic historical investigation")).toBeTruthy();
  });

  it("hides the filter entirely when no entities are recorded", async () => {
    stubFetch();
    render(<Cases roles={["case-lead"]} view="investigations" />);
    await screen.findByText("Synthetic historical investigation");
    expect(screen.queryByLabelText("Filter investigations by involved entity")).toBeNull();
  });
});

describe("a manual investigation with no model run", () => {
  it("still summarises the human record in Situation", async () => {
    stubFetch();
    render(<Cases roles={["case-lead"]} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Synthetic historical investigation" }),
    );
    await screen.findByRole("heading", { name: "Situation" });
    // A note, a possible explanation, and a next step: recorded by people,
    // summarised without any comparison having been run.
    const briefing = await screen.findByRole("heading", {
      name: "Where the investigation stands",
    });
    expect(briefing).toBeTruthy();
    expect(screen.getByText("The scheduled batch and the checkout traffic overlap.")).toBeTruthy();
    expect(
      screen.getByText("Move the synthetic batch outside the checkout window."),
    ).toBeTruthy();
    expect(screen.getByText("Pool exhausted during the batch window.")).toBeTruthy();
  });
});
