import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderDto, RouterBudgetDto } from "../lib/host";
import type { AppSetupState } from "../lib/preflight";
import { SettingsModal } from "./SettingsModal";

const hostMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  getActiveProvider: vi.fn(),
  saveActiveProvider: vi.fn(),
  saveConfluence: vi.fn(),
  saveX: vi.fn(),
  setRouterBudget: vi.fn(),
  suggestDefaultWorkspace: vi.fn(),
}));

vi.mock("../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/host")>();
  return {
    ...original,
    hostConfluenceHasToken: vi.fn(async () => false),
    hostGetActiveProvider: hostMocks.getActiveProvider,
    hostGetConfluence: vi.fn(async () => null),
    hostGetRouterBudget: vi.fn(async () => null),
    hostGetWebResearchEnabled: vi.fn(async () => false),
    hostGetX: vi.fn(async () => null),
    hostListConnectorKinds: vi.fn(async () => []),
    hostListConnectors: vi.fn(async () => []),
    hostListLocalCandidates: vi.fn(async () => []),
    hostListWebResearchSources: vi.fn(async () => []),
    hostProviderHasSecret: vi.fn(async () => false),
    hostSaveActiveProvider: hostMocks.saveActiveProvider,
    hostSaveConfluence: hostMocks.saveConfluence,
    hostSaveConnectors: vi.fn(async () => []),
    hostSaveX: hostMocks.saveX,
    hostSetRouterBudget: hostMocks.setRouterBudget,
    hostSetWebResearchEnabled: vi.fn(async (enabled: boolean) => enabled),
    hostSuggestDefaultWorkspace: hostMocks.suggestDefaultWorkspace,
    hostXHasToken: vi.fn(async () => false),
  };
});

vi.mock("../lib/dialogs", () => ({
  dialogConfirm: hostMocks.confirm,
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
    writeEnabled: false,
  },
  x: { enabled: false, hasToken: false },
  webResearchEnabled: false,
};

const activeProvider: ProviderDto = {
  id: "ollama-local",
  kind: "ollama",
  base_url: setup.baseUrl,
  chat_model: setup.chatModel,
  label: setup.providerLabel ?? "Local model",
  api_key_ref: null,
  has_key: false,
  tools_enabled: true,
  deadline_preference: "auto",
};

const routerBudget: RouterBudgetDto = {
  max_sources: 3,
  max_tool_rounds: 12,
  max_results_per_source: 8,
  deadline_ms: 120_000,
  deadline_is_explicit: false,
};

function renderSettings() {
  const onClose = vi.fn();
  const onSaveSetup = vi.fn();
  render(
    <SettingsModal
      open
      initialSection="health"
      setup={setup}
      theme="dark"
      onThemeChange={vi.fn()}
      onClose={onClose}
      onSaveSetup={onSaveSetup}
    />,
  );
  return { onClose, onSaveSetup };
}

async function waitForHostHydration() {
  await waitFor(() =>
    expect(hostMocks.suggestDefaultWorkspace).toHaveBeenCalledTimes(1),
  );
  await act(async () => {});
  expect(hostMocks.getActiveProvider).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
}

function openWorkspaceSection() {
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  hostMocks.confirm.mockResolvedValue(false);
  hostMocks.getActiveProvider.mockResolvedValue(activeProvider);
  hostMocks.saveActiveProvider.mockResolvedValue(activeProvider);
  hostMocks.saveConfluence.mockResolvedValue({
    enabled: false,
    base_url: "",
    spaces: [],
    pat_ref: null,
    write_enabled: false,
  });
  hostMocks.saveX.mockResolvedValue({
    enabled: false,
    api_key_ref: null,
  });
  hostMocks.setRouterBudget.mockResolvedValue(routerBudget);
  hostMocks.suggestDefaultWorkspace.mockResolvedValue({
    path: "/Users/test/Documents/ContextDesk",
    label: "Documents/ContextDesk",
    exists: true,
  });
});

describe("Settings dirty-state lifecycle (#740)", () => {
  it("closes after untouched host hydration without a discard warning", async () => {
    const { onClose } = renderSettings();
    await waitForHostHydration();

    fireEvent.click(screen.getByTitle("Close"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(hostMocks.confirm).not.toHaveBeenCalled();
  });

  it("warns for a genuine edit and an explicit discard restores a clean draft", async () => {
    const { onClose } = renderSettings();
    await waitForHostHydration();
    openWorkspaceSection();

    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Incident response" },
    });
    expect(
      screen.getByRole("button", { name: "Cancel (unsaved)" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByTitle("Close"));
    await waitFor(() =>
      expect(hostMocks.confirm).toHaveBeenCalledWith(
        "You have unsaved settings changes. Discard them?",
        { title: "Discard changes", kind: "warning" },
      ),
    );
    expect(onClose).not.toHaveBeenCalled();

    hostMocks.confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByTitle("Close"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      (screen.getByLabelText("Workspace name") as HTMLInputElement).value,
    ).toBe("Workspace");
  });

  it("marks a successfully saved edit clean before closing", async () => {
    const { onClose, onSaveSetup } = renderSettings();
    await waitForHostHydration();
    openWorkspaceSection();

    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Incident response" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(onSaveSetup).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceName: "Incident response" }),
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hostMocks.confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
