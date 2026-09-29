import { useEffect, useLayoutEffect, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordedContextFields } from "./RecordedContextFields.js";
import type { RecordedContextCatalog, RecordedContextDraft, RecordedContextTuple } from "./recorded-context-options.js";

afterEach(cleanup);

const EMPTY: RecordedContextDraft = {
  productName: "", version: "", build: "", component: "", environment: "", organization: "",
};
const FIRST = { investigationContext: { productName: "Desk", version: "1", build: "b1", component: "worker" } };
const SECOND = { investigationContext: { productName: "Other", version: "9", build: "b9", organization: "Synthetic Group" } };
const AVAILABLE: RecordedContextCatalog = { status: "available", records: [FIRST, SECOND], partial: true };

function reactClick(button: HTMLElement): () => void {
  const key = Object.keys(button).find((item) => item.startsWith("__reactProps$"));
  if (!key) throw new Error("React event props not found");
  const props = (button as unknown as Record<string, { onClick?: () => void }>)[key];
  if (!props?.onClick) throw new Error("React click callback not found");
  return props.onClick;
}

describe("recorded context control", () => {
  it("applies only an exact recorded tuple after an explicit action and keeps manual fields", () => {
    const writes = vi.fn();
    function Form() {
      const [draft, setDraft] = useState<RecordedContextDraft>({ ...EMPTY, component: "manual component", organization: "manual organization" });
      return <form onSubmit={(event) => { event.preventDefault(); writes(); }}>
        <RecordedContextFields scopeKey="person:A" draft={draft} catalog={AVAILABLE}
          onFieldChange={(field, value) => setDraft((current) => ({ ...current, [field]: value }))}
          onTupleApply={(tuple) => setDraft((current) => ({ ...current,
            productName: tuple.productName, version: tuple.version, build: tuple.build }))} />
      </form>;
    }
    render(<Form />);
    const chooser = screen.getByRole("combobox", { name: "Recorded product / version / build combination" });
    fireEvent.change(chooser, { target: { value: JSON.stringify(["Desk", "1", "b1"]) } });
    expect(screen.getByText(/Only product, version, and build in this local draft will be replaced/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Software or product" }) as HTMLInputElement).value).toBe("");
    expect(writes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply combination to draft" }));
    expect((screen.getByRole("combobox", { name: "Software or product" }) as HTMLInputElement).value).toBe("Desk");
    expect((screen.getByRole("combobox", { name: "Version" }) as HTMLInputElement).value).toBe("1");
    expect((screen.getByRole("combobox", { name: "Build" }) as HTMLInputElement).value).toBe("b1");
    expect((screen.getByRole("combobox", { name: "Component" }) as HTMLInputElement).value).toBe("manual component");
    expect((screen.getByRole("combobox", { name: "Organization, customer, or entity" }) as HTMLInputElement).value).toBe("manual organization");
    expect(writes).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Build" }), { target: { value: "manual build" } });
    expect((screen.getByRole("combobox", { name: "Build" }) as HTMLInputElement).value).toBe("manual build");
  });

  it("holds selection by exact tuple through reorder and disables a removed candidate", () => {
    const applied = vi.fn<(tuple: RecordedContextTuple) => void>();
    const view = render(<RecordedContextFields scopeKey="A" draft={EMPTY} catalog={AVAILABLE}
      onFieldChange={vi.fn()} onTupleApply={applied} />);
    const chooser = screen.getByRole("combobox", { name: "Recorded product / version / build combination" });
    fireEvent.change(chooser, { target: { value: JSON.stringify(["Desk", "1", "b1"]) } });
    view.rerender(<RecordedContextFields scopeKey="A" draft={EMPTY}
      catalog={{ ...AVAILABLE, records: [SECOND, FIRST] }} onFieldChange={vi.fn()} onTupleApply={applied} />);
    expect((chooser as HTMLSelectElement).value).toBe(JSON.stringify(["Desk", "1", "b1"]));
    fireEvent.click(screen.getByRole("button", { name: "Apply combination to draft" }));
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ productName: "Desk", version: "1", build: "b1" }));
    view.rerender(<RecordedContextFields scopeKey="A" draft={EMPTY}
      catalog={{ ...AVAILABLE, records: [SECOND] }} onFieldChange={vi.fn()} onTupleApply={applied} />);
    expect((screen.getByRole("button", { name: "Apply combination to draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("conceals obsolete options before passive cleanup and rejects retained A to B to A callbacks", () => {
    const applied = vi.fn();
    let retainedA: (() => void) | null = null;
    let passiveCleanups = 0;
    let cleanupAtReplacement = -1;
    function Wrapper({ scope, catalog }: { scope: string; catalog: RecordedContextCatalog }) {
      useEffect(() => () => { passiveCleanups += 1; }, [scope]);
      useLayoutEffect(() => {
        if (scope === "B") {
          cleanupAtReplacement = passiveCleanups;
          retainedA?.();
        }
      }, [scope]);
      return <RecordedContextFields scopeKey={scope} draft={EMPTY} catalog={catalog}
        onFieldChange={vi.fn()} onTupleApply={applied} />;
    }
    const view = render(<Wrapper scope="A" catalog={AVAILABLE} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Recorded product / version / build combination" }),
      { target: { value: JSON.stringify(["Desk", "1", "b1"]) } });
    retainedA = reactClick(screen.getByRole("button", { name: "Apply combination to draft" }));
    view.rerender(<Wrapper scope="B" catalog={{ status: "not-requested", records: [], partial: true }} />);
    expect(cleanupAtReplacement).toBe(0);
    expect(applied).not.toHaveBeenCalled();
    expect(screen.queryByText(/Product: Desk · Version: 1 · Build: b1/)).toBeNull();
    expect(document.querySelectorAll("datalist option")).toHaveLength(0);
    view.rerender(<Wrapper scope="A" catalog={AVAILABLE} />);
    retainedA?.();
    expect(applied).not.toHaveBeenCalled();
  });

  it("uses unique IDs for simultaneous mounts and names a stale source", () => {
    render(<><RecordedContextFields scopeKey="A" draft={EMPTY} catalog={AVAILABLE} onFieldChange={vi.fn()} onTupleApply={vi.fn()} />
      <RecordedContextFields scopeKey="A" draft={EMPTY} catalog={{ ...AVAILABLE, status: "stale" }} onFieldChange={vi.fn()} onTupleApply={vi.fn()} /></>);
    const products = screen.getAllByRole("combobox", { name: "Software or product" });
    expect(products).toHaveLength(2);
    expect(products[0]?.id).not.toBe(products[1]?.id);
    expect(products[0]?.getAttribute("list")).not.toBe(products[1]?.getAttribute("list"));
    expect(screen.getByText(/Showing the last loaded authorized investigation records after a failed refresh/)).toBeTruthy();
    expect((screen.getAllByRole("button", { name: "Apply combination to draft" })[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels a refreshing previous snapshot, prevents tuple application, and retains manual draft text", () => {
    const applied = vi.fn();
    render(<RecordedContextFields scopeKey="A" draft={{ ...EMPTY, component: "manual component" }}
      catalog={{ ...AVAILABLE, status: "refreshing" }} onFieldChange={vi.fn()} onTupleApply={applied} />);
    expect(screen.getByText(/refresh is in progress.*may be stale/i)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Component" }) as HTMLInputElement).value).toBe("manual component");
    expect((screen.getByRole("button", { name: "Apply combination to draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Last loaded investigation suggestions are being refreshed/)).toHaveLength(6);
    expect(document.querySelectorAll("datalist option").length).toBeGreaterThan(0);
    expect(applied).not.toHaveBeenCalled();
  });

  it("describes an empty loaded set locally and preserves a manual value beyond the display cap", () => {
    const view = render(<RecordedContextFields scopeKey="A" draft={EMPTY}
      catalog={{ status: "empty", records: [], partial: true }} onFieldChange={vi.fn()} onTupleApply={vi.fn()} />);
    expect(screen.getAllByText(/No values in the currently loaded investigation records/)).toHaveLength(6);
    const records = Array.from({ length: 101 }, (_, i) => ({ investigationContext: { productName: `Fixture ${i}` } }));
    view.rerender(<RecordedContextFields scopeKey="A" draft={{ ...EMPTY, productName: "Fixture 100" }}
      catalog={{ status: "available", records, partial: true }} onFieldChange={vi.fn()} onTupleApply={vi.fn()} />);
    const product = screen.getByRole("combobox", { name: "Software or product" });
    expect((product as HTMLInputElement).value).toBe("Fixture 100");
    expect(document.getElementById(product.getAttribute("aria-describedby") ?? "")?.textContent)
      .toMatch(/Matches a value in the loaded investigation records, outside the displayed options.*first 100 distinct suggestions/);
  });
});
