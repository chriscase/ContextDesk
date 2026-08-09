/**
 * Capability qualification panel (#724) — explicit start, no auto-run on mount.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityQualificationPanel } from "./CapabilityQualificationPanel";
import type { QualificationReportDto } from "../../lib/host";
import { SKINS } from "../../lib/skins";

const here = dirname(fileURLToPath(import.meta.url));

const getQual = vi.fn();
const startQual = vi.fn();
const cancelQual = vi.fn();
const clearQual = vi.fn();

vi.mock("../../lib/host", async () => {
  const actual = await vi.importActual<typeof import("../../lib/host")>(
    "../../lib/host",
  );
  return {
    ...actual,
    hostGetCapabilityQualification: (...args: unknown[]) => getQual(...args),
    hostStartCapabilityQualification: (...args: unknown[]) => startQual(...args),
    hostCancelCapabilityQualification: (...args: unknown[]) =>
      cancelQual(...args),
    hostClearCapabilityQualification: (...args: unknown[]) => clearQual(...args),
  };
});

function sampleReport(
  over: Partial<QualificationReportDto> = {},
): QualificationReportDto {
  return {
    profile_id: "p1",
    endpoint_fingerprint: "abc",
    model_id: "gpt-4o",
    schema_version: "contextdesk.capability_qualification.v1",
    role_hint: "chat",
    cancelled: false,
    stale: false,
    finished_at: 1,
    readiness: {
      role: "chat",
      state: "limited",
      basis: "measured",
      tested_at: 1,
      detail: "Basic chat works, but tool use did not pass.",
    },
    checks: [
      {
        kind: "basic_generation",
        status: "pass",
        elapsed_ms: 12,
        tested_at: 1,
        reason: "synthetic marker present",
      },
      {
        kind: "native_tool_call",
        status: "fail",
        elapsed_ms: 5,
        tested_at: 1,
        reason: "no native tool call",
      },
    ],
    ...over,
  };
}

describe("CapabilityQualificationPanel (#724)", () => {
  beforeEach(() => {
    getQual.mockReset();
    startQual.mockReset();
    cancelQual.mockReset();
    clearQual.mockReset();
    getQual.mockResolvedValue(null);
    startQual.mockResolvedValue(sampleReport());
    cancelQual.mockResolvedValue(true);
    clearQual.mockResolvedValue(true);
  });

  it("does not auto-start qualification on mount", async () => {
    render(
      <CapabilityQualificationPanel
        baseId="t"
        modelId="gpt-4o"
        baseUrl="https://gateway.example/v1"
        apiKeyDraft=""
        enabled
      />,
    );
    await waitFor(() => expect(getQual).toHaveBeenCalled());
    expect(getQual).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() }),
    );
    expect(startQual).not.toHaveBeenCalled();
    const btn = screen.getByTestId("cap-qual-start");
    expect(btn.textContent).toContain("Qualify selected model");
  });

  it("starts on explicit click and shows per-check status", async () => {
    const onReadinessChanged = vi.fn();
    render(
      <CapabilityQualificationPanel
        baseId="t"
        modelId="gpt-4o"
        baseUrl="https://gateway.example/v1"
        apiKeyDraft="sk-test"
        enabled
        onReadinessChanged={onReadinessChanged}
      />,
    );
    await waitFor(() => expect(getQual).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("cap-qual-start"));
    await waitFor(() => expect(startQual).toHaveBeenCalledTimes(1));
    expect(startQual).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-4o",
        baseUrl: "https://gateway.example/v1",
        apiKey: "sk-test",
      }),
    );
    await waitFor(() => screen.getByTestId("cap-qual-report"));
    expect(screen.getByTestId("cap-qual-report").textContent).toMatch(/pass/);
    expect(screen.getByTestId("cap-qual-report").textContent).toMatch(/fail/);
    const basis = screen.getByTestId("cap-qual-basis");
    expect(basis.textContent).toMatch(/Name hint/);
    expect(basis.textContent).toMatch(/Measured locally/);
    expect(screen.getByTestId("cap-qual-summary").textContent).toMatch(
      /limited for chat/i,
    );
    expect(onReadinessChanged).toHaveBeenCalledWith(
      "p1",
      "gpt-4o",
      expect.objectContaining({ state: "limited", basis: "measured" }),
    );
    expect(getQual).toHaveBeenCalledTimes(1);
  });

  it("shows cancel while running and supports clear", async () => {
    let resolveStart: (v: QualificationReportDto) => void = () => {};
    startQual.mockImplementation(
      () =>
        new Promise<QualificationReportDto>((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(
      <CapabilityQualificationPanel
        baseId="t"
        modelId="mistral"
        baseUrl="http://127.0.0.1:11434"
        apiKeyDraft=""
        enabled
      />,
    );
    await waitFor(() => expect(getQual).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("cap-qual-start"));
    await waitFor(() => screen.getByTestId("cap-qual-cancel"));
    fireEvent.click(screen.getByTestId("cap-qual-cancel"));
    expect(cancelQual).toHaveBeenCalled();
    await act(async () => {
      resolveStart(sampleReport({ model_id: "mistral", cancelled: true }));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("cap-qual-report").getAttribute("data-cancelled"),
      ).toBe("true");
    });
    fireEvent.click(screen.getByTestId("cap-qual-clear"));
    await waitFor(() => expect(clearQual).toHaveBeenCalled());
    expect(clearQual).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("cap-qual-report")).toBeNull(),
    );
  });

  it("disables start without model or when not enabled", () => {
    const { rerender } = render(
      <CapabilityQualificationPanel
        baseId="t"
        modelId=""
        baseUrl="http://127.0.0.1:11434"
        apiKeyDraft=""
        enabled
      />,
    );
    expect(
      (screen.getByTestId("cap-qual-start") as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(
      <CapabilityQualificationPanel
        baseId="t"
        modelId="mistral"
        baseUrl="http://127.0.0.1:11434"
        apiKeyDraft=""
        enabled={false}
      />,
    );
    expect(
      (screen.getByTestId("cap-qual-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows stale banner when report is stale", async () => {
    getQual.mockResolvedValue(sampleReport({ stale: true }));
    render(
      <CapabilityQualificationPanel
        baseId="t"
        modelId="gpt-4o"
        baseUrl="https://gateway.example/v1"
        apiKeyDraft=""
        enabled
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("cap-qual-report").getAttribute("data-stale"),
      ).toBe("true");
    });
    expect(screen.getByTestId("cap-qual-report").textContent).toMatch(/stale/i);
  });

  it("retry clears then re-starts qualification", async () => {
    getQual.mockResolvedValue(sampleReport({ stale: true }));
    startQual.mockResolvedValue(sampleReport({ stale: false }));
    render(
      <CapabilityQualificationPanel
        baseId="t"
        modelId="gpt-4o"
        baseUrl="https://gateway.example/v1"
        apiKeyDraft=""
        enabled
      />,
    );
    await waitFor(() => screen.getByTestId("cap-qual-retry"));
    fireEvent.click(screen.getByTestId("cap-qual-retry"));
    await waitFor(() => expect(clearQual).toHaveBeenCalled());
    await waitFor(() => expect(startQual).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        screen.getByTestId("cap-qual-report").getAttribute("data-stale"),
      ).toBe("false");
    });
  });

  it("exposes keyboard focus and live status for the start control", async () => {
    render(
      <CapabilityQualificationPanel
        baseId="t"
        modelId="gpt-4o"
        baseUrl="https://gateway.example/v1"
        apiKeyDraft=""
        enabled
      />,
    );
    await waitFor(() => expect(getQual).toHaveBeenCalled());
    const btn = screen.getByTestId("cap-qual-start") as HTMLButtonElement;
    expect(btn.type).toBe("button");
    expect(btn.getAttribute("aria-describedby")).toBeTruthy();
    const statusId = btn.getAttribute("aria-describedby")!;
    const status = document.getElementById(statusId);
    expect(status).not.toBeNull();
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    btn.focus();
    expect(document.activeElement).toBe(btn);
    // Enter activates the focused button (native button keyboard contract).
    fireEvent.keyDown(btn, { key: "Enter", code: "Enter" });
    fireEvent.click(btn);
    await waitFor(() => expect(startQual).toHaveBeenCalled());
  });

  it("uses theme tokens under every shipped skin", () => {
    const css = readFileSync(
      join(here, "../../styles/components/settings.css"),
      "utf8",
    );
    expect(css).toMatch(/\.cap-qual[\s\S]*var\(--border/);
    expect(css).toMatch(/\.cap-qual__status--pass[\s\S]*var\(--ok/);
    expect(css).toMatch(/\.cap-qual__status--fail[\s\S]*var\(--danger/);
    expect(css).toMatch(/\.cap-qual__meta[\s\S]*var\(--text-muted/);

    for (const skin of SKINS) {
      const themeCss = readFileSync(
        join(here, "../../styles/themes", `${skin.id}.css`),
        "utf8",
      );
      for (const token of ["border", "text-muted", "text"]) {
        expect(themeCss, `${skin.id} --${token}`).toMatch(
          new RegExp(`--${token}\\s*:`),
        );
      }
      document.documentElement.dataset.theme = skin.id;
      const view = render(
        <CapabilityQualificationPanel
          baseId={`theme-${skin.id}`}
          modelId="gpt-4o"
          baseUrl="https://gateway.example/v1"
          apiKeyDraft=""
          enabled
        />,
      );
      const root = screen.getByTestId("capability-qualification");
      expect(document.documentElement.dataset.theme).toBe(skin.id);
      expect(root.classList.contains("cap-qual")).toBe(true);
      expect(root.getAttribute("style")).toBeNull();
      view.unmount();
    }
  });
});
