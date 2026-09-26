import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceUploadReconciliationForm, type EvidenceUploadReconciliationFormProps } from "./EvidenceUploadReconciliationForm.js";
afterEach(cleanup);
const original = new File(["synthetic original bytes"], "original.log", { type: "text/plain" });
function props(): EvidenceUploadReconciliationFormProps {
  return { variant: "investigation-first", scopeKey: "case-A:alice:lead:private:open", canRead: true, canUpload: true, canReadPrivate: true,
    readCompletion: { requested: 0, succeeded: 0, failed: -1 }, refreshEvidence: vi.fn(() => 2),
    upload: vi.fn(async () => ({ status: "failed" as const, error: { kind: "unavailable", reason: "commit_outcome_unknown" }, evidenceReadGeneration: 1 })) };
}
function fill() {
  fireEvent.change(screen.getByLabelText("File"), { target: { files: [original] } });
  fireEvent.change(screen.getByLabelText("Annotation"), { target: { value: "  original summary  " } });
  fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "log" } });
}
describe("evidence recovery form handlers", () => {
  it("direct submits cannot bypass recovery and retry ignores programmatically changed disabled controls", async () => {
    const initial = props(); const view = render(<EvidenceUploadReconciliationForm {...initial} />); fill();
    const form = screen.getByRole("button", { name: "Add to evidence inventory" }).closest("form")!;
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(initial.upload).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("File").hasAttribute("disabled")).toBe(true);
    view.rerender(<EvidenceUploadReconciliationForm {...initial} readCompletion={{ requested: 1, succeeded: 1, failed: -1 }} />);
    const controls = form.elements;
    (controls.namedItem("summary") as HTMLInputElement).value = "changed";
    (controls.namedItem("kind") as HTMLSelectElement).value = "email";
    (controls.namedItem("privacyClass") as HTMLSelectElement).value = "share_safe";
    Object.defineProperty(controls.namedItem("file"), "files", { configurable: true, value: [new File(["changed"], "changed.log")] });
    await act(async () => fireEvent.submit(form));
    expect(initial.upload).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry original upload" })));
    const calls = vi.mocked(initial.upload!).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]![0]).toEqual(calls[0]![0]);
    expect(calls[1]![0]).toMatchObject({ file: original, summary: "  original summary  ", kind: "log", privacyClass: "owner_only" });
  });
  it("announces validated first-upload success and resets the original file and summary", async () => {
    const initial = { ...props(), upload: vi.fn(async () => ({ status: "succeeded" as const })) };
    render(<EvidenceUploadReconciliationForm {...initial} />); fill();
    await act(async () => fireEvent.submit(screen.getByLabelText("File").closest("form")!));
    expect(screen.getByText("Evidence added to the inventory.").getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(screen.getByText("Evidence added to the inventory."));
    expect((screen.getByLabelText("Annotation") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("File") as HTMLInputElement).value).toBe("");
    expect(initial.upload).toHaveBeenCalledTimes(1);
  });
  it("scope replacement drops controls synchronously and a detached captured form cannot write into A-B-A", async () => {
    const initial = props(); const view = render(<EvidenceUploadReconciliationForm {...initial} />); fill();
    const oldForm = screen.getByLabelText("File").closest("form")!;
    await act(async () => fireEvent.submit(oldForm));
    view.rerender(<EvidenceUploadReconciliationForm {...initial} scopeKey="B" />);
    expect((screen.getByLabelText("Annotation") as HTMLInputElement).value).toBe("");
    view.rerender(<EvidenceUploadReconciliationForm {...initial} />);
    await act(async () => fireEvent.submit(oldForm));
    expect(initial.upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry original upload" })).toBeNull();
  });
  it("no upload authority exposes a read-only notice and never invokes upload", async () => {
    const initial = props(); render(<EvidenceUploadReconciliationForm {...initial} canUpload={false} />);
    await waitFor(() => expect(screen.getByText(/your current access cannot attach a file/)).toBeTruthy());
    expect(screen.queryByLabelText("File")).toBeNull(); expect(initial.upload).not.toHaveBeenCalled();
  });
});
