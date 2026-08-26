/**
 * The record panel as an operator meets it.
 *
 * Every fixture here is synthetic. The cases that matter most are the ones
 * about honesty: a date recorded without a time zone must never be shown as a
 * moment in time, a renamed label must not silently rewrite what an older
 * investigation said, and a citation the reader cannot open must show that it
 * exists without disclosing what it is.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvestigationRecordPanel,
  describeOccurrence,
  describeRecordedAt,
  type InvolvementRow,
  type ReferenceRow,
} from "./InvestigationRecord.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CASE_ID = "22222222-2222-4222-8222-222222222222";

const entity = {
  id: "e1",
  kind: "organization" as const,
  label: "Fable Harbor",
  profile: null,
  privacyClass: "owner_only" as const,
  lifecycle: "active" as const,
};

function involvement(overrides: Partial<InvolvementRow> = {}): InvolvementRow {
  return {
    id: "i1",
    entityId: "e1",
    relationship: "affected",
    state: "active",
    note: "Named in the synthetic intake summary.",
    recordedLabel: "Fable Harbor",
    recordedKind: "organization",
    currentLabel: "Fable Harbor",
    currentKind: "organization",
    currentLifecycle: "active",
    occurredAt: "2024-11-04",
    occurredAtPrecision: "day",
    occurredAtZone: "unspecified",
    recordedAt: "2026-08-25T14:02:00.000Z",
    recordedByUsername: "alice",
    releasedAt: null,
    ...overrides,
  };
}

function reference(overrides: Partial<ReferenceRow> = {}): ReferenceRow {
  return {
    id: "r1",
    fromInvestigationId: CASE_ID,
    toInvestigationId: OTHER_CASE_ID,
    resourceKind: "investigation",
    locator: `/investigations/${OTHER_CASE_ID}/situation?section=stage-situation#stage-situation`,
    note: "Same synthetic timeout signature.",
    recordedTitle: "Synthetic checkout timeouts (2019)",
    currentTitle: "Synthetic checkout timeouts (2019)",
    visibility: "resolved",
    state: "active",
    recordedAt: "2026-08-25T14:05:00.000Z",
    recordedByUsername: "alice",
    ...overrides,
  };
}

function stubFetch(options?: {
  involvements?: InvolvementRow[];
  outbound?: ReferenceRow[];
  inbound?: ReferenceRow[];
  onWrite?: (url: string, init?: RequestInit) => { ok: boolean; body?: unknown } | null;
}) {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const handled = options?.onWrite?.(url, init);
      if (handled) {
        return { ok: handled.ok, json: async () => handled.body ?? {} };
      }
      return { ok: true, json: async () => ({}) };
    }
    if (url === "/api/entities") {
      return { ok: true, json: async () => ({ entities: [entity] }) };
    }
    if (url.endsWith("/involvement")) {
      return {
        ok: true,
        json: async () => ({ involvements: options?.involvements ?? [] }),
      };
    }
    if (url.includes("/software-impact/suggestions")) {
      return { ok: true, json: async () => ({ values: [] }) };
    }
    if (url.endsWith("/software-impact")) {
      return { ok: true, json: async () => ({ records: [] }) };
    }
    if (url.endsWith("/references")) {
      return {
        ok: true,
        json: async () => ({
          outbound: options?.outbound ?? [],
          inbound: options?.inbound ?? [],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

function renderPanel(
  overrides: Partial<Parameters<typeof InvestigationRecordPanel>[0]> = {},
) {
  return render(
    <InvestigationRecordPanel
      caseId={CASE_ID}
      canWrite
      occurrence={{
        occurredAt: "2024-11-04",
        occurredAtPrecision: "day",
        occurredAtZone: "unspecified",
      }}
      createdAt="2026-08-25T14:02:00.000Z"
      investigations={[{ id: OTHER_CASE_ID, title: "Synthetic prior investigation" }]}
      onOccurrenceSaved={() => undefined}
      {...overrides}
    />,
  );
}

describe("showing when something happened", () => {
  it("never renders a zone-unspecified date as a moment in time", () => {
    expect(
      describeOccurrence({
        occurredAt: "2024-11-04",
        occurredAtPrecision: "day",
        occurredAtZone: "unspecified",
      }),
    ).toBe("2024-11-04 (date only, time zone not recorded)");
    expect(
      describeOccurrence({
        occurredAt: "2019",
        occurredAtPrecision: "year",
        occurredAtZone: "unspecified",
      }),
    ).toContain("year only");
  });

  it("renders a value that carried an offset as a real instant", () => {
    const rendered = describeOccurrence({
      occurredAt: "2024-11-04T09:30:00.000Z",
      occurredAtPrecision: "second",
      occurredAtZone: "explicit",
    });
    expect(rendered).not.toContain("time zone not recorded");
    expect(rendered).toBe(describeRecordedAt("2024-11-04T09:30:00.000Z"));
  });

  it("says so plainly when nobody has written it down", () => {
    expect(
      describeOccurrence({
        occurredAt: null,
        occurredAtPrecision: "unknown",
        occurredAtZone: "unspecified",
      }),
    ).toBe("Not recorded");
  });

  it("shows both clocks side by side on a backfilled investigation", async () => {
    stubFetch();
    renderPanel();
    const happened = await screen.findByTestId("occurred-at");
    expect(happened.textContent).toContain("2024-11-04");
    expect(happened.textContent).toContain("time zone not recorded");
    const recorded = screen.getByTestId("recorded-at");
    expect(recorded.textContent).not.toBe("Not recorded");
    expect(recorded.textContent).not.toContain("2024-11-04");
  });

  it("offers to record a date on an investigation that has none", async () => {
    stubFetch();
    renderPanel({
      occurrence: {
        occurredAt: null,
        occurredAtPrecision: "unknown",
        occurredAtZone: "unspecified",
      },
    });
    const open = await screen.findByRole("button", { name: "Record when it happened" });
    fireEvent.click(open);
    const field = await screen.findByLabelText("Date it happened");
    expect(field).toBeTruthy();
    expect(
      screen.getByText(/leaving it out is recorded as not known, not guessed/i),
    ).toBeTruthy();
  });

  it("sends the typed date through unchanged", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const stub = stubFetch({
      onWrite: (url, init) => {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return { ok: true, body: {} };
      },
    });
    renderPanel({
      occurrence: {
        occurredAt: null,
        occurredAtPrecision: "unknown",
        occurredAtZone: "unspecified",
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Record when it happened" }));
    fireEvent.change(await screen.findByLabelText("Date it happened"), {
      target: { value: "2024-11-04" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Record when this happened" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toContain("/occurred-at");
    expect(posts[0]?.body).toEqual({ occurredAt: "2024-11-04" });
    expect(stub).toHaveBeenCalled();
  });
});

describe("involvement and historical attribution", () => {
  it("shows the label the investigation recorded, and the drift beside it", async () => {
    stubFetch({
      involvements: [
        involvement({ currentLabel: "Fable Harbor Holdings", currentLifecycle: "retired" }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Fable Harbor")).toBeTruthy();
    expect(
      screen.getByText(/Recorded here as “Fable Harbor”\. Now called “Fable Harbor Holdings”/),
    ).toBeTruthy();
    expect(screen.getByText(/This label is retired for new work/)).toBeTruthy();
  });

  it("says what is missing rather than showing an empty box", async () => {
    stubFetch();
    renderPanel();
    expect(
      await screen.findByText(/No entities are recorded yet\./),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Affected software" })).toBeTruthy();
    expect(screen.getByText(/No affected software is recorded yet\./)).toBeTruthy();
    expect(screen.getByText(/builds are not ordered, and a later version is never inferred/i)).toBeTruthy();
  });

  it("keeps an ended involvement visible instead of removing it", async () => {
    stubFetch({
      involvements: [
        involvement({
          id: "i2",
          state: "released",
          releasedAt: "2026-08-25T15:00:00.000Z",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Ended involvement (1)")).toBeTruthy();
    expect(
      screen.getByText(/Kept so the record still shows it was once involved\./),
    ).toBeTruthy();
  });

  it("explains a retired label rather than failing silently", async () => {
    stubFetch({
      onWrite: () => ({ ok: false, body: { error: "entity_retired" } }),
    });
    renderPanel();
    fireEvent.change(await screen.findByLabelText("Entity"), { target: { value: "e1" } });
    fireEvent.submit(screen.getByRole("form", { name: "Add an involved entity" }));
    expect(
      await screen.findByText(/retired and cannot be added to new work/i),
    ).toBeTruthy();
  });
});

describe("citations", () => {
  it("states that a citation is not evidence", async () => {
    stubFetch();
    renderPanel();
    expect(
      await screen.findByText(/does not become supporting evidence here/i),
    ).toBeTruthy();
  });

  it("shows a resolved citation with a way to open it", async () => {
    stubFetch({ outbound: [reference()] });
    renderPanel();
    expect(await screen.findByText("Synthetic checkout timeouts (2019)")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open the cited investigation" });
    // The deep link is the canonical in-app address, so it survives being
    // copied out of the page rather than only working as a click handler.
    expect(link.getAttribute("href")).toBe(
      `/investigations/${OTHER_CASE_ID}/situation?section=stage-situation#stage-situation`,
    );
  });

  it("shows a restricted citation without disclosing the current title", async () => {
    stubFetch({
      outbound: [
        reference({
          visibility: "restricted",
          currentTitle: null,
          recordedTitle: "Synthetic restricted target",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Restricted investigation")).toBeTruthy();
    expect(screen.getByText(/You do not have access to open this investigation/)).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Open the cited investigation" }),
    ).toBeNull();
  });

  it("explains a refused citation in terms of access, not failure", async () => {
    stubFetch({
      onWrite: () => ({ ok: false, body: { error: "cited_investigation_forbidden" } }),
    });
    renderPanel();
    fireEvent.change(await screen.findByLabelText("Investigation to cite"), {
      target: { value: OTHER_CASE_ID },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Cite another investigation" }));
    expect(
      await screen.findByText(/you do not have access to read it/i),
    ).toBeTruthy();
  });

  it("shows citations of this investigation from elsewhere", async () => {
    stubFetch({ inbound: [reference({ id: "r2", toInvestigationId: CASE_ID })] });
    renderPanel();
    expect(await screen.findByText("Investigations that cite this one (1)")).toBeTruthy();
  });
});

describe("read-only viewers", () => {
  it("shows the record without offering any way to change it", async () => {
    stubFetch({ involvements: [involvement()], outbound: [reference()] });
    renderPanel({ canWrite: false });
    expect(await screen.findByText("Fable Harbor")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add an involved entity" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Cite another investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record when it happened/ })).toBeNull();
  });
});
