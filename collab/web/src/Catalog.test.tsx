import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  SOURCE_SCHEMA_ID,
  type SourceMutationAction,
  type SourceMutationRefusedV1,
  type SourceMutationSuccessV1,
  type SourceV1,
} from "@cd-collab/contracts/source-catalog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog, type CatalogProps } from "./Catalog.js";
import type {
  SourceCatalogFailure,
  SourceCatalogGateway,
  SourceCatalogResult,
} from "./source-catalog/gateway.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RETIRED_ID = "22222222-2222-4222-8222-222222222222";
const LEGACY_ID = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function source(overrides: Partial<SourceV1> = {}): SourceV1 {
  return {
    schemaId: SOURCE_SCHEMA_ID,
    id: SOURCE_ID,
    name: "Synthetic assistant",
    kind: "external-tool",
    description: "Pasted support analysis",
    lifecycle: "active",
    identityId: null,
    createdAt: "2026-09-05T12:00:00.000Z",
    createdBy: "attr:creator",
    revision: 1,
    ...overrides,
  };
}

function ok<T>(value: T): SourceCatalogResult<T> {
  return { ok: true, value } as SourceCatalogResult<T>;
}

function fail<T>(error: SourceCatalogFailure): SourceCatalogResult<T> {
  return { ok: false, error };
}

function success(
  action: SourceMutationAction,
  applied: SourceV1 & { revision: number },
  replayed = false,
): SourceMutationSuccessV1 {
  const previousRevision = action === "create" ? 0 : applied.revision - 1;
  return {
    schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
    action,
    sourceId: applied.id,
    expectedRevision: previousRevision,
    previousRevision,
    appliedRevision: applied.revision,
    replayed,
    applied,
  };
}

function refused(
  action: SourceMutationAction,
  reason: SourceMutationRefusedV1["reason"],
  current: SourceV1 | null,
  expectedRevision: number,
): SourceMutationRefusedV1 {
  return {
    schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
    error: "source_catalog_refused",
    action,
    sourceId: current?.id ?? SOURCE_ID,
    expectedRevision,
    reason,
    detail: "Bounded synthetic refusal.",
    current,
  };
}

function gatewayWith(overrides: Partial<SourceCatalogGateway> = {}): SourceCatalogGateway {
  return {
    list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [] })),
    create: vi.fn(async () => fail<SourceMutationSuccessV1>({ kind: "unexpected" })),
    retire: vi.fn(async () => fail<SourceMutationSuccessV1>({ kind: "unexpected" })),
    restore: vi.fn(async () => fail<SourceMutationSuccessV1>({ kind: "unexpected" })),
    ...overrides,
  };
}

function renderCatalog(gateway: SourceCatalogGateway, overrides: Partial<CatalogProps> = {}) {
  return render(
    <Catalog
      canRead={true}
      canWrite={true}
      identityKey="alice"
      authorityKey="catalog-writer-v1"
      gateway={gateway}
      keyFactory={() => "source-key-0001"}
      {...overrides}
    />,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Source Catalog Console", () => {
  it("keeps a read-denied route nonbusy and request-free", async () => {
    const gateway = gatewayWith();
    renderCatalog(gateway, { canRead: false, canWrite: true });

    expect(screen.getByRole("heading", { name: "Attribution is unavailable in this view" })).toBeTruthy();
    expect(screen.getByText(/no catalog data was requested/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Attribution labels" }).getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("button", { name: /Try loading/ })).toBeNull();
    expect(gateway.list).not.toHaveBeenCalled();
    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.retire).not.toHaveBeenCalled();
    expect(gateway.restore).not.toHaveBeenCalled();
  });

  it("shows compact counts, filters in server order, and protects legacy and permanent rows", async () => {
    const legacy = source({ id: LEGACY_ID, name: "Legacy person", kind: "human" });
    delete legacy.revision;
    const rows = [
      source({ name: "Assistant one" }),
      source({ id: RETIRED_ID, name: "Retired monitor", kind: "internal-system", lifecycle: "retired", revision: 4 }),
      legacy,
      source({ id: PERMANENT_UNKNOWN_SOURCE_ID, name: "Unknown origin", kind: "unknown", revision: 9 }),
    ];
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: rows })),
    });
    renderCatalog(gateway);

    const list = await screen.findByRole("list", { name: "Attribution labels" });
    expect(within(list).getAllByRole("listitem").map((row) => row.querySelector("strong")?.textContent))
      .toEqual(["Assistant one", "Retired monitor", "Legacy person", "Unknown origin"]);
    expect(screen.getByText("Legacy record · read-only")).toBeTruthy();
    expect(screen.getByText("Permanent · protected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Legacy person/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unknown origin/ })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "internal-system" } });
    expect(screen.getByText("Retired monitor")).toBeTruthy();
    expect(screen.queryByText("Assistant one")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Lifecycle" }), { target: { value: "active" } });
    expect(screen.getByRole("heading", { name: "No labels match these filters" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "person" } });
    expect(screen.getByText("Legacy person")).toBeTruthy();
    expect(screen.getByText("1 of 4 labels shown.")).toBeTruthy();
    expect(gateway.list).toHaveBeenCalledTimes(1);
  });

  it("preserves confirmed rows through refresh failure and recovers on retry", async () => {
    const refresh = deferred<SourceCatalogResult<{ schemaId: typeof SOURCE_LIST_SCHEMA_ID; sources: SourceV1[] }>>();
    const list = vi.fn()
      .mockResolvedValueOnce(ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [source()] }))
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce(ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [source({ name: "Confirmed after retry" })] }));
    const gateway = gatewayWith({ list });
    renderCatalog(gateway);
    expect(await screen.findByText("Synthetic assistant")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Previously confirmed rows remain shown/)).toBeTruthy();
    refresh.resolve(fail({ kind: "internal", status: 500 }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Previously confirmed labels remain shown/);
    expect(screen.getByText("Synthetic assistant")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try loading the catalog again" }));
    expect(await screen.findByText("Confirmed after retry")).toBeTruthy();
  });

  it("keeps create values while running and resets only after confirmed success", async () => {
    let rows: SourceV1[] = [];
    const pending = deferred<SourceCatalogResult<SourceMutationSuccessV1>>();
    const created = source({ name: "Grafana alerts", kind: "internal-system", description: "On-call stream", revision: 1 });
    const create = vi.fn(async (_request) => {
      const result = await pending.promise;
      if (result.ok) rows = [result.value.applied];
      return result;
    });
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: rows })),
      create,
    });
    renderCatalog(gateway);
    await screen.findByRole("heading", { name: "No attribution labels are registered yet" });

    fireEvent.change(screen.getByRole("combobox", { name: "Source kind" }), { target: { value: "internal-system" } });
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    const description = screen.getByRole("textbox", { name: /Description/ }) as HTMLTextAreaElement;
    fireEvent.change(name, { target: { value: "Grafana alerts" } });
    fireEvent.change(description, { target: { value: "On-call stream" } });
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    expect(name.value).toBe("Grafana alerts");
    expect(name.disabled).toBe(true);
    pending.resolve(ok(success("create", created as SourceV1 & { revision: number })));

    expect(await screen.findByText("Added Grafana alerts.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Added Grafana alerts.").parentElement));
    expect(name.value).toBe("");
    expect(description.value).toBe("");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Grafana alerts",
      kind: "internal-system",
      description: "On-call stream",
      identityId: null,
      expectedRevision: 0,
      idempotencyKey: "source-key-0001",
    }), expect.any(AbortSignal));
  });

  it.each(["network", "commit_outcome_unknown"] as const)(
    "locks all writes and retries the exact saved request after %s",
    async (kind) => {
      let rows: SourceV1[] = [];
      const created = source({ name: "Uncertain assistant", revision: 1 });
      const attempts: unknown[] = [];
      const create = vi.fn(async (request) => {
        attempts.push(request);
        if (attempts.length === 1) {
          return kind === "network"
            ? fail<SourceMutationSuccessV1>({ kind: "network" })
            : fail<SourceMutationSuccessV1>({ kind: "commit_outcome_unknown", status: 503 });
        }
        rows = [created];
        return ok(success("create", created as SourceV1 & { revision: number }, true));
      });
      const gateway = gatewayWith({
        list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: rows })),
        create,
      });
      const keyFactory = vi.fn(() => "source-uncertain-0001");
      renderCatalog(gateway, { keyFactory });
      await screen.findByRole("heading", { name: "No attribution labels are registered yet" });
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Uncertain assistant" } });
      fireEvent.click(screen.getByRole("button", { name: "Add label" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/may have completed/);
      expect(document.activeElement).toBe(alert);
      expect((screen.getByRole("button", { name: "Add label" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(alert).getByRole("button", { name: "Retry the same request" }));
      expect(await screen.findByText("Added Uncertain assistant.")).toBeTruthy();
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toBe(attempts[0]);
      expect(keyFactory).toHaveBeenCalledTimes(1);
    },
  );

  it("requires confirmation to retire, supports restore, and announces both outcomes", async () => {
    let current = source();
    const retire = vi.fn(async () => {
      current = source({ lifecycle: "retired", revision: 2 });
      return ok(success("retire", current as SourceV1 & { revision: number }));
    });
    const restore = vi.fn(async () => {
      current = source({ lifecycle: "active", revision: 3 });
      return ok(success("restore", current as SourceV1 & { revision: number }));
    });
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [current] })),
      retire,
      restore,
    });
    let key = 0;
    renderCatalog(gateway, { keyFactory: () => `source-key-000${++key}` });
    fireEvent.click(await screen.findByRole("button", { name: "Retire Synthetic assistant…" }));
    expect(retire).not.toHaveBeenCalled();
    expect(screen.getByText(/Past attribution is preserved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep active" }));
    expect(retire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retire Synthetic assistant…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm retire Synthetic assistant" }));
    expect(await screen.findByText("Retired Synthetic assistant.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore Synthetic assistant" }));
    expect(await screen.findByText("Restored Synthetic assistant.")).toBeTruthy();
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }), expect.any(AbortSignal));
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2 }), expect.any(AbortSignal));
  });

  it("renders a bounded 409 refusal, reconciles the row, and requires a new action", async () => {
    let listed = source();
    const current = source({ lifecycle: "retired", revision: 2 });
    const retire = vi.fn(async () => {
      listed = current;
      return fail<SourceMutationSuccessV1>({
        kind: "refused",
        status: 409,
        refusal: refused("retire", "expected_revision_mismatch", current, 1),
      });
    });
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [listed] })),
      retire,
    });
    renderCatalog(gateway);
    fireEvent.click(await screen.findByRole("button", { name: "Retire Synthetic assistant…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm retire Synthetic assistant" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/changed before the action/);
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole("button", { name: "Restore Synthetic assistant" })).toBeTruthy();
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("lets a read-only viewer browse without any mutation control", async () => {
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [source()] })),
    });
    renderCatalog(gateway, { canWrite: false });
    expect(await screen.findByText("Synthetic assistant")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/requires catalog write access/);
    expect(screen.queryByRole("heading", { name: "Add attribution label" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retire|Restore/ })).toBeNull();
  });
});
