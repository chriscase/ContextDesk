import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "./Catalog.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface StubSource {
  id: string;
  name: string;
  kind: string;
  lifecycle: string;
  description?: string | null;
  createdAt?: string;
}

function source(overrides: Partial<StubSource> & { id: string; name: string }): StubSource {
  return {
    kind: "external-tool",
    lifecycle: "active",
    description: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function stubList(sources: StubSource[]) {
  const mock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ sources: [...sources] }),
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function catalogListener() {
  const listener = vi.fn();
  window.addEventListener("contextdesk:source-catalog-changed", listener);
  return {
    listener,
    dispose: () => window.removeEventListener("contextdesk:source-catalog-changed", listener),
  };
}

describe("attribution library", () => {
  it("explains all five kinds in plain language, keeping unknown honest", async () => {
    stubList([
      source({ id: "1", name: "Priya", kind: "human" }),
      source({ id: "2", name: "Chat assistant", kind: "external-tool" }),
      source({ id: "3", name: "Grafana", kind: "internal-system" }),
      source({ id: "4", name: "Carried brief", kind: "contextdesk" }),
      source({ id: "5", name: "Old ticket paste", kind: "unknown" }),
    ]);
    render(<Catalog canLead={true} />);

    const legend = await screen.findByRole("region", { name: "What can supply information" });
    for (const label of [
      "Person",
      "External tool",
      "Internal system",
      "ContextDesk",
      "Unknown origin",
    ]) {
      expect(within(legend).getByText(label)).toBeTruthy();
    }
    expect(within(legend).queryByText("external-tool", { selector: "code" })).toBeNull();
    // Unknown is a first-class honest value, never presented as failure.
    expect(
      within(legend).getByText(/never an error, and never upgraded to a guess/),
    ).toBeTruthy();
    // Sources are attribution, not credentials, connections, or correctness.
    expect(screen.getByText(/not user accounts and do not connect to the named tools/)).toBeTruthy();
    expect(
      within(legend).getByText(/ContextDesk never connects to the tool itself/),
    ).toBeTruthy();
    // Each kind card reports a truthful active count.
    expect(within(legend).getAllByText("1 active source")).toHaveLength(5);
  });

  it("groups active and retired sources with truthful counts", async () => {
    stubList([
      source({ id: "1", name: "Chat assistant", kind: "external-tool" }),
      source({ id: "2", name: "Priya", kind: "human" }),
      source({ id: "3", name: "Legacy scanner", kind: "external-tool", lifecycle: "retired" }),
    ]);
    render(<Catalog canLead={false} />);

    const activeGroup = await screen.findByRole("region", { name: "Available attribution labels (2)" });
    expect(within(activeGroup).getByText("Chat assistant")).toBeTruthy();
    expect(within(activeGroup).getByText("Priya")).toBeTruthy();

    const retiredGroup = screen.getByRole("region", { name: "Retired attribution labels (1)" });
    expect(within(retiredGroup).getByText("Legacy scanner")).toBeTruthy();
    expect(within(retiredGroup).getByText("retired")).toBeTruthy();
    // Retirement is presented as non-destructive to history.
    expect(
      within(retiredGroup).getByText(/retirement hides, it never rewrites/),
    ).toBeTruthy();

    const activeFact = screen.getByText("Available labels", { selector: "dt" }).parentElement!;
    expect(within(activeFact).getByText("2")).toBeTruthy();
    const retiredFact = screen.getByText("Retired labels", { selector: "dt" }).parentElement!;
    expect(within(retiredFact).getByText("1")).toBeTruthy();
    // Only active external tools count as ready for manual intake.
    const intakeFact = screen.getByText("Tools available for pasted output", {
      selector: "dt",
    }).parentElement!;
    expect(within(intakeFact).getByText("1")).toBeTruthy();
  });

  it("submits the exact legacy payload and resets only after success", async () => {
    const sources = [source({ id: "1", name: "Chat assistant" })];
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/catalog/sources" && method === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        sources.push(source({ id: "2", name: "Grafana alerts", kind: "internal-system" }));
        return { ok: true, json: async () => ({ id: "2" }) };
      }
      return { ok: true, json: async () => ({ sources: [...sources] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { listener, dispose } = catalogListener();

    render(<Catalog canLead={true} />);
    expect(await screen.findByText("Chat assistant")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Internal system/ }));
    const name = screen.getByRole("textbox", { name: "Source name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Grafana alerts" } });
    const description = screen.getByRole("textbox", {
      name: "Source description",
    }) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "On-call alert stream" } });
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));

    // While the POST is in flight nothing is reset.
    expect(name.value).toBe("Grafana alerts");

    expect(await screen.findByText("Grafana alerts", { selector: ".catalog__name" })).toBeTruthy();
    expect(name.value).toBe("");
    expect(description.value).toBe("");
    expect(
      (screen.getByRole("radio", { name: /External tool/ }) as HTMLInputElement).checked,
    ).toBe(true);

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeTruthy();
    expect(String(postCall![1]?.body)).toBe(
      JSON.stringify({
        name: "Grafana alerts",
        kind: "internal-system",
        description: "On-call alert stream",
      }),
    );
    expect(postCall![1]?.headers).toEqual({
      "content-type": "application/json",
      "x-cd-collab-csrf": "1",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("defaults registration to external-tool and explains manual intake", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      if (String(input) === "/api/catalog/sources" && init?.method === "POST") {
        return { ok: true, json: async () => ({ id: "9" }) };
      }
      return { ok: true, json: async () => ({ sources: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { listener, dispose } = catalogListener();
    render(<Catalog canLead={true} />);

    const name = await screen.findByRole("textbox", { name: "Source name" });
    // Kind-specific guidance for the default kind: manual, no provider access.
    expect(screen.getByText(/No credentials are stored and no automatic connection/)).toBeTruthy();
    fireEvent.change(name, { target: { value: "Claude chat assistant" } });
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    dispose();

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall![1]?.body))).toEqual({
      name: "Claude chat assistant",
      kind: "external-tool",
      description: "",
    });
  });

  it("keeps a denied create bounded and preserves the entered values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        if (String(input) === "/api/catalog/sources" && (init?.method ?? "GET") === "POST") {
          return { ok: false, status: 403, json: async () => ({ error: "permission denied" }) };
        }
        return { ok: true, json: async () => ({ sources: [] }) };
      }),
    );
    const { listener, dispose } = catalogListener();
    render(<Catalog canLead={true} />);

    const name = (await screen.findByRole("textbox", {
      name: "Source name",
    })) as HTMLInputElement;
    fireEvent.click(screen.getByRole("radio", { name: /Unknown origin/ }));
    fireEvent.change(name, { target: { value: "Denied source" } });
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Source could not be added. You may not have permission to manage the catalog.",
    );
    expect(screen.queryByText("permission denied")).toBeNull();
    expect(name.value).toBe("Denied source");
    expect(
      (screen.getByRole("radio", { name: /Unknown origin/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    dispose();
  });

  it("retires only after an explicit confirmation and dispatches the event", async () => {
    let lifecycle = "active";
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/catalog/sources/1/retire" && init?.method === "POST") {
        lifecycle = "retired";
        return { ok: true, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          sources: [source({ id: "1", name: "Chat assistant", lifecycle })],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { listener, dispose } = catalogListener();
    render(<Catalog canLead={true} />);

    const retireButton = await screen.findByRole("button", { name: "Retire Chat assistant" });
    fireEvent.click(retireButton);
    // First click only asks; nothing has been posted yet.
    expect(
      fetchMock.mock.calls.find(([input]) => String(input).endsWith("/retire")),
    ).toBeUndefined();
    expect(screen.getByText(/every past attribution keeps it/)).toBeTruthy();

    // Backing out keeps the source active.
    fireEvent.click(screen.getByRole("button", { name: "Keep active" }));
    expect(screen.queryByRole("button", { name: "Confirm retire Chat assistant" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retire Chat assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm retire Chat assistant" }));

    expect(await screen.findByRole("region", { name: "Retired attribution labels (1)" })).toBeTruthy();
    const retireCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/retire"));
    expect(String(retireCall![0])).toBe("/api/catalog/sources/1/retire");
    expect(retireCall![1]).toEqual({
      method: "POST",
      headers: { "x-cd-collab-csrf": "1" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("keeps a denied retire bounded and leaves the source in place", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        if (String(input).endsWith("/retire") && init?.method === "POST") {
          return { ok: false, status: 403, json: async () => ({ error: "forbidden by policy" }) };
        }
        return {
          ok: true,
          json: async () => ({ sources: [source({ id: "1", name: "Chat assistant" })] }),
        };
      }),
    );
    render(<Catalog canLead={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retire Chat assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm retire Chat assistant" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Source could not be retired. You may not have permission to manage the catalog.",
    );
    expect(screen.queryByText("forbidden by policy")).toBeNull();
    expect(screen.getByText("Chat assistant")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Available attribution labels (1)" })).toBeTruthy();
  });

  it("shows no mutation controls to non-leads while staying informative", async () => {
    stubList([
      source({ id: "1", name: "Chat assistant", description: "Pasted transcripts" }),
      source({ id: "2", name: "Old scanner", lifecycle: "retired" }),
    ]);
    render(<Catalog canLead={false} />);

    expect(await screen.findByText("Chat assistant")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retire/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    // Provenance stays fully browsable: description, kinds, and groups render.
    expect(screen.getByText("Pasted transcripts")).toBeTruthy();
    expect(screen.getByRole("region", { name: "What can supply information" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Retired attribution labels (1)" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("read access");
  });

  it("shows a loading state until the library arrives", async () => {
    let resolveFetch: (value: unknown) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => (resolveFetch = resolve))),
    );
    render(<Catalog canLead={false} />);

    expect(screen.getByRole("status").textContent).toContain("Loading attribution labels");
    resolveFetch({ ok: true, json: async () => ({ sources: [] }) });
    expect(await screen.findByText("No sources are registered yet.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a bounded load error and recovers on retry", async () => {
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        failing
          ? { ok: false, status: 500, json: async () => ({ error: "database exploded" }) }
          : {
              ok: true,
              json: async () => ({ sources: [source({ id: "1", name: "Chat assistant" })] }),
            },
      ),
    );
    render(<Catalog canLead={true} />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Attribution labels could not be loaded. Try again.",
    );
    expect(screen.queryByText("database exploded")).toBeNull();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading attribution" }));
    expect(await screen.findByText("Chat assistant")).toBeTruthy();
  });

  it("explains an empty library to leads and to read-only viewers", async () => {
    stubList([]);
    render(<Catalog canLead={true} />);
    expect(await screen.findByText("No sources are registered yet.")).toBeTruthy();
    expect(screen.getByText(/Register the first one below/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add label" })).toBeTruthy();
    cleanup();

    stubList([]);
    render(<Catalog canLead={false} />);
    expect(await screen.findByText("No sources are registered yet.")).toBeTruthy();
    expect(screen.getByText(/A case lead can register the first one/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
  });

  it("renders long unbroken text and unexpected kinds without inventing meaning", async () => {
    const longName = "tool-".repeat(40) + "end";
    const longDescription = "x".repeat(300);
    stubList([
      source({ id: "1", name: longName, description: longDescription }),
      source({ id: "2", name: "Mystery feed", kind: "weird-kind" }),
    ]);
    render(<Catalog canLead={false} />);

    expect(await screen.findByText(longName)).toBeTruthy();
    expect(screen.getByText(longDescription)).toBeTruthy();
    // An unrecognized kind stays the recorded token instead of a guessed label.
    const card = screen.getByText("Mystery feed").closest("li")!;
    expect(within(card).getByText("weird-kind", { selector: ".catalog-chip" })).toBeTruthy();
  });

  it("filters purely client-side with an accessible searchbox", async () => {
    const fetchMock = stubList([
      source({ id: "1", name: "Chat assistant", description: "Pasted transcripts" }),
      source({ id: "2", name: "Priya", kind: "human" }),
      source({ id: "3", name: "Grafana", kind: "internal-system", lifecycle: "retired" }),
    ]);
    render(<Catalog canLead={false} />);
    expect(await screen.findByText("Priya")).toBeTruthy();
    const callsBefore = fetchMock.mock.calls.length;

    const box = screen.getByRole("searchbox", { name: "Filter sources" });
    fireEvent.change(box, { target: { value: "chat" } });
    expect(screen.getByText("Chat assistant")).toBeTruthy();
    expect(screen.queryByText("Priya")).toBeNull();
    expect(screen.getByText("1 of 3 sources match.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Available attribution labels (1 of 2)" })).toBeTruthy();
    expect(screen.getByText("No retired labels match the filter.")).toBeTruthy();

    // Kind labels match too, so "person" finds human sources.
    fireEvent.change(box, { target: { value: "person" } });
    expect(screen.getByText("Priya")).toBeTruthy();
    expect(screen.queryByText("Chat assistant")).toBeNull();

    fireEvent.change(box, { target: { value: "" } });
    expect(screen.getByText("Chat assistant")).toBeTruthy();
    expect(screen.getByText("Grafana")).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
