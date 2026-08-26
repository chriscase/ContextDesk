import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SoftwareImpactPanel } from "./SoftwareImpact.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASE_ID = "11111111-1111-4111-8111-111111111111";

function impact(overrides: Record<string, unknown> = {}) {
  return {
    id: "impact-1",
    productName: "Fixture Desk",
    version: "4.2",
    build: "build-007",
    component: "queue-worker",
    environment: "QA / us-central",
    status: "confirmed",
    note: "Failing line appears only on this synthetic worker image.",
    state: "active",
    recordedAt: "2026-08-26T08:00:00.000Z",
    recordedByUsername: "alice",
    releasedAt: null,
    ...overrides,
  };
}

function stubFetch(options?: {
  records?: ReturnType<typeof impact>[];
  suggestions?: Record<string, string[]>;
  missing?: boolean;
  onWrite?: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body?: unknown };
}) {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const handled = options?.onWrite?.(url, init);
      if (handled) {
        return {
          ok: handled.ok,
          status: handled.status ?? (handled.ok ? 200 : 400),
          json: async () => handled.body ?? {},
        };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    }
    if (url.includes("/software-impact/suggestions")) {
      const field = new URL(url, "http://war-room.test").searchParams.get("field") ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({ values: options?.suggestions?.[field] ?? [] }),
      };
    }
    if (url.endsWith("/software-impact")) {
      if (options?.missing) return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ records: options?.records ?? [] }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("SoftwareImpactPanel", () => {
  it("says plainly that builds are not ordered", async () => {
    stubFetch({ records: [impact()] });
    render(<SoftwareImpactPanel caseId={CASE_ID} canWrite />);
    expect(
      await screen.findByText(/builds are not ordered, and a later version is never inferred/i),
    ).toBeTruthy();
    expect(screen.getByText(/recording order, not build order/i)).toBeTruthy();
    expect(screen.getByText("Confirmed", { selector: ".software-impact__status" })).toBeTruthy();
  });

  it("lets a person type a new value while still offering existing suggestions", async () => {
    stubFetch({
      suggestions: { productName: ["Fixture Desk"], build: ["build-007"] },
    });
    render(<SoftwareImpactPanel caseId={CASE_ID} canWrite />);
    const product = await screen.findByRole("combobox", { name: "Software or product" });
    const list = document.getElementById("software-impact-options-productName");
    expect(list?.querySelector('option[value="Fixture Desk"]')).toBeTruthy();
    fireEvent.change(product, { target: { value: "A brand-new product label" } });
    expect((product as HTMLInputElement).value).toBe("A brand-new product label");
  });

  it("records a free-form identity and the chosen epistemic status", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch({
      onWrite: (url, init) => {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return { ok: true, status: 201, body: impact() };
      },
    });
    render(<SoftwareImpactPanel caseId={CASE_ID} canWrite />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Build" }), {
      target: { value: "build-007" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Software or product" }), {
      target: { value: "Fixture Desk" },
    });
    fireEvent.change(screen.getByLabelText("Impact status"), { target: { value: "confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Record affected software" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.url).toBe(`/api/cases/${CASE_ID}/software-impact`);
    expect(posts[0]?.body).toEqual({
      productName: "Fixture Desk",
      version: "",
      build: "build-007",
      component: "",
      environment: "",
      status: "confirmed",
      note: "",
    });
  });

  it("keeps viewers read-only", async () => {
    stubFetch({ records: [impact()] });
    render(<SoftwareImpactPanel caseId={CASE_ID} canWrite={false} />);
    expect(await screen.findByText("Fixture Desk · 4.2 · build-007 · queue-worker · QA / us-central")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record affected software" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Software or product" })).toBeNull();
  });

  it("renders nothing when this host does not offer the route", async () => {
    stubFetch({ missing: true });
    const { container } = render(<SoftwareImpactPanel caseId={CASE_ID} canWrite />);
    await waitFor(() => expect(container.querySelector("#software-impact-title")).toBeNull());
  });
});
