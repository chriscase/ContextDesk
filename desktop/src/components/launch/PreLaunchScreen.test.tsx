import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoLogInstallDto, ProcessProgressDto } from "../../lib/host";
import type { AppSetupState, PreflightReport } from "../../lib/preflight";
import { PreLaunchScreen } from "./PreLaunchScreen";

const hostMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  install: vi.fn(),
  listCandidates: vi.fn(),
  suggestWorkspace: vi.fn(),
  ensureWorkspace: vi.fn(),
  setWorkspace: vi.fn(),
  progressCallback: null as ((progress: ProcessProgressDto) => void) | null,
  unlisten: vi.fn(),
}));

vi.mock("../../lib/host", () => ({
  hostCancelLogIngest: hostMocks.cancel,
  hostInstallDemoLogCorpus: hostMocks.install,
  hostListLocalCandidates: hostMocks.listCandidates,
  hostSuggestDefaultWorkspace: hostMocks.suggestWorkspace,
  hostEnsureDefaultWorkspace: hostMocks.ensureWorkspace,
  hostSetWorkspace: hostMocks.setWorkspace,
  hostListenProcessProgress: vi.fn(
    (callback: (progress: ProcessProgressDto) => void) => {
      hostMocks.progressCallback = callback;
      return Promise.resolve(hostMocks.unlisten);
    },
  ),
}));

vi.mock("../settings/AiSetupWizard", () => ({
  AiSetupWizard: () => <div aria-label="AI setup">AI setup</div>,
}));

const setup: AppSetupState = {
  dataDirWritable: true,
  workspaceName: "Workspace",
  workspaceRoots: ["/workspace"],
  providerLabel: "Local model",
  providerKind: "ollama",
  chatModel: "mistral",
  baseUrl: "http://127.0.0.1:11434",
  hasApiKey: false,
  toolsEnabled: true,
  localOnly: true,
  ollamaReachable: true,
  remoteReachable: null,
  confluence: {
    enabled: false,
    baseUrl: "",
    spaces: "",
    hasToken: false,
  },
  x: { enabled: false, hasToken: false },
  webResearchEnabled: false,
};

const preflight: PreflightReport = {
  hasBlocking: false,
  items: [
    {
      id: "workspace.roots",
      title: "Workspace roots",
      level: "pass",
      detail: "One root.",
    },
    {
      id: "provider.active",
      title: "AI provider",
      level: "pass",
      detail: "Local model.",
    },
    {
      id: "memory.store",
      title: "Memory",
      level: "warn",
      detail: "Optional memory setup.",
      fixAction: "connectors",
    },
  ],
};

function installed(
  status: DemoLogInstallDto["status"] = "installed",
): DemoLogInstallDto {
  return {
    status,
    demoIdentity: "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1",
    corpusId: "demo-corpus",
    corpusName: "Demo · seven-day performance triage",
    events: 25_000,
    detail:
      status === "already_installed"
        ? "The packaged demo corpus is already installed and selected."
        : "The packaged demo corpus is installed and selected.",
    retryable: false,
  };
}

function renderReady() {
  const onEnterApp = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <PreLaunchScreen
      productName="ContextDesk"
      tagline="Developer knowledge workbench"
      setup={setup}
      preflight={preflight}
      onSaveSetup={vi.fn()}
      onApplyAi={vi.fn()}
      onRecheck={vi.fn()}
      onEnterApp={onEnterApp}
      onOpenSettings={onOpenSettings}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Continue to AI setup →" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue to Ready →" }));
  return { onEnterApp, onOpenSettings };
}

beforeEach(() => {
  vi.clearAllMocks();
  hostMocks.install.mockReset();
  hostMocks.progressCallback = null;
  hostMocks.listCandidates.mockResolvedValue([]);
  hostMocks.suggestWorkspace.mockResolvedValue(null);
  hostMocks.cancel.mockResolvedValue(true);
});

describe("optional first-run demo corpus (#732)", () => {
  it("defaults to skip and preserves the existing Enter-app path", () => {
    const { onEnterApp } = renderReady();

    expect(
      (
        screen.getByRole("checkbox", {
          name: /Install demo log corpus/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Install demo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter app" }));

    expect(hostMocks.install).not.toHaveBeenCalled();
    expect(onEnterApp).toHaveBeenCalledWith({ openLogs: false });
  });

  it("does not block entry when selected, then shows real progress and blocks only while running", async () => {
    let resolveInstall: (value: DemoLogInstallDto) => void = () => {};
    hostMocks.install.mockReturnValue(
      new Promise<DemoLogInstallDto>((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const { onOpenSettings } = renderReady();

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Install demo log corpus/ }),
    );
    expect(
      (screen.getByRole("button", { name: "Enter app" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Fix" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install demo" }));

    expect(
      (screen.getByRole("button", { name: "Enter app" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Fix" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "← Back" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Recheck" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(
      screen.getByRole("progressbar", {
        name: "Demo corpus installation progress",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(hostMocks.progressCallback).toBeTypeOf("function"),
    );
    act(() => {
      hostMocks.progressCallback?.({
        kind: "log_ingest",
        phase: "parse",
        message: "Parsing safe log lines…",
        fraction: 0.42,
        lines_processed: 10_500,
        files_processed: 4,
        bytes_processed: 1_700_000,
        templates: 18,
        cancellable: true,
      });
    });
    expect(screen.getByText("Parsing safe log lines…")).toBeTruthy();
    expect(screen.getByText("10,500 lines")).toBeTruthy();

    await act(async () => resolveInstall(installed()));
    await waitFor(() =>
      expect(screen.getByText("Demo installed")).toBeTruthy(),
    );
    const enter = screen.getByRole("button", {
      name: "Enter app · Open Logs",
    });
    await waitFor(() => expect(document.activeElement).toBe(enter));
    expect((enter as HTMLButtonElement).disabled).toBe(false);
  });

  it("requests cancellation through the ordinary ingest cancel path", async () => {
    let resolveInstall: (value: DemoLogInstallDto) => void = () => {};
    hostMocks.install.mockReturnValue(
      new Promise<DemoLogInstallDto>((resolve) => {
        resolveInstall = resolve;
      }),
    );
    renderReady();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Install demo log corpus/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install demo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(hostMocks.cancel).toHaveBeenCalledTimes(1));
    expect(
      (
        screen.getByRole("button", {
          name: "Cancelling…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () =>
      resolveInstall({
        status: "cancelled",
        demoIdentity: "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1",
        corpusId: null,
        corpusName: "Demo · seven-day performance triage",
        events: null,
        detail: "Installation cancelled. No demo corpus was installed.",
        retryable: true,
      }),
    );
    const retry = await screen.findByRole("button", {
      name: "Retry installation",
    });
    expect(screen.getByText("Installation cancelled")).toBeTruthy();
    expect(screen.getByText(/No demo corpus was installed/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(retry));
  });

  it("keeps cancellation failure visible while installation continues", async () => {
    hostMocks.install.mockReturnValue(new Promise<DemoLogInstallDto>(() => {}));
    hostMocks.cancel.mockResolvedValueOnce(false);
    renderReady();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Install demo log corpus/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install demo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cancellation could not be requested");
    expect(alert.textContent).toContain("installation is still running");
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("does not expose host cancellation errors in the launch UI", async () => {
    hostMocks.install.mockReturnValue(new Promise<DemoLogInstallDto>(() => {}));
    hostMocks.cancel.mockRejectedValueOnce(
      new Error("private /Users/example path"),
    );
    renderReady();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Install demo log corpus/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install demo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cancellation could not be requested");
    expect(alert.textContent).not.toContain("/Users/example");
  });

  it("handles the idempotent already-installed result and routes Enter to Logs", async () => {
    hostMocks.install.mockResolvedValue(installed("already_installed"));
    const { onEnterApp } = renderReady();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Install demo log corpus/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install demo" }));

    await waitFor(() =>
      expect(screen.getByText("Demo already installed")).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Enter app · Open Logs" }),
    );
    expect(onEnterApp).toHaveBeenCalledWith({ openLogs: true });
  });

  it("keeps failure visible, focuses Retry, and can recover", async () => {
    hostMocks.install
      .mockResolvedValueOnce({
        status: "failed",
        demoIdentity: "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1",
        corpusId: null,
        corpusName: "Demo · seven-day performance triage",
        events: null,
        detail: "Synthetic import failure",
        retryable: true,
      } satisfies DemoLogInstallDto)
      .mockResolvedValueOnce(installed());
    renderReady();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Install demo log corpus/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install demo" }));

    const retry = await screen.findByRole("button", {
      name: "Retry installation",
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Synthetic import failure",
    );
    await waitFor(() => expect(document.activeElement).toBe(retry));
    fireEvent.click(retry);
    await screen.findByText("Demo installed");
    expect(hostMocks.install).toHaveBeenCalledTimes(2);
  });

  it("renders browser unavailability honestly without blocking entry", async () => {
    hostMocks.install.mockResolvedValue({
      status: "unavailable",
      demoIdentity: "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1",
      corpusId: null,
      corpusName: "Demo · seven-day performance triage",
      events: null,
      detail: "Packaged demo logs require the installed desktop app.",
      retryable: false,
    } satisfies DemoLogInstallDto);
    renderReady();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Install demo log corpus/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install demo" }));

    await screen.findByText("Demo unavailable");
    expect(screen.queryByText("Demo installed")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Enter app" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("keeps the full optional flow operable at narrow, normal, and wide widths", async () => {
    for (const width of [360, 960, 1_600]) {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      window.dispatchEvent(new Event("resize"));
      hostMocks.install.mockResolvedValueOnce(installed());
      const { onEnterApp } = renderReady();

      const choice = screen.getByRole("checkbox", {
        name: /25,000 synthetic events/,
      });
      choice.focus();
      expect(document.activeElement).toBe(choice);
      fireEvent.click(choice);
      expect((choice as HTMLInputElement).checked).toBe(true);
      const install = screen.getByRole("button", { name: "Install demo" });
      expect((install as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(install);
      const enter = await screen.findByRole("button", {
        name: "Enter app · Open Logs",
      });
      await waitFor(() => expect(document.activeElement).toBe(enter));
      fireEvent.click(enter);
      expect(onEnterApp).toHaveBeenCalledWith({ openLogs: true });

      cleanup();
    }
  });
});
