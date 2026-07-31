/**
 * Rechecking connectivity is an inspection, not an edit (#740 residual).
 *
 * The hydration baseline fix stopped host-loaded config from reading as an
 * edit, but `recheck()` writes *measured* results — ollamaReachable,
 * remoteReachable — straight into the draft without moving the baseline. So
 * pressing Recheck and then Close still raised "You have unsaved settings
 * changes. Discard them?" over settings the user never touched.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderDto } from "../lib/host";
import type { AppSetupState } from "../lib/preflight";
import { SettingsModal } from "./SettingsModal";

const hostMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  getActiveProvider: vi.fn(),
  suggestDefaultWorkspace: vi.fn(),
  checkOllama: vi.fn(),
}));

vi.mock("../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/host")>();
  return {
    ...original,
    hostCheckOllama: hostMocks.checkOllama,
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
    hostSuggestDefaultWorkspace: hostMocks.suggestDefaultWorkspace,
    hostXHasToken: vi.fn(async () => false),
  };
});

vi.mock("../lib/dialogs", () => ({ dialogConfirm: hostMocks.confirm }));

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
  // Starts unknown; the probe below resolves it to a different value, which is
  // exactly the transition that used to mark the draft dirty.
  ollamaReachable: null,
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
  label: "Local model",
  api_key_ref: null,
  has_key: false,
  tools_enabled: true,
  deadline_preference: "auto",
};

function renderSettings() {
  const onClose = vi.fn();
  render(
    <SettingsModal
      open
      initialSection="health"
      setup={setup}
      theme="dark"
      onThemeChange={vi.fn()}
      onClose={onClose}
      onSaveSetup={vi.fn()}
    />,
  );
  return { onClose };
}

async function waitForHydration() {
  await waitFor(() =>
    expect(hostMocks.suggestDefaultWorkspace).toHaveBeenCalledTimes(1),
  );
  await act(async () => {});
}

async function recheck() {
  fireEvent.click(screen.getByRole("button", { name: /Recheck/i }));
  await waitFor(() => expect(hostMocks.checkOllama).toHaveBeenCalled());
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  hostMocks.confirm.mockResolvedValue(false);
  hostMocks.getActiveProvider.mockResolvedValue(activeProvider);
  hostMocks.checkOllama.mockResolvedValue(true);
  hostMocks.suggestDefaultWorkspace.mockResolvedValue({
    path: "/Users/test/Documents/ContextDesk",
    label: "Documents/ContextDesk",
    exists: true,
  });
});

describe("connectivity recheck is not an edit (#740)", () => {
  it("closes without a discard warning after a successful recheck", async () => {
    const { onClose } = renderSettings();
    await waitForHydration();
    await recheck();

    fireEvent.click(screen.getByTitle("Close"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(hostMocks.confirm).not.toHaveBeenCalled();
  });

  it("closes cleanly when the recheck reports the provider unreachable", async () => {
    hostMocks.checkOllama.mockResolvedValue(false);
    const { onClose } = renderSettings();
    await waitForHydration();
    await recheck();

    fireEvent.click(screen.getByTitle("Close"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(hostMocks.confirm).not.toHaveBeenCalled();
  });

  it("keeps the Cancel affordance out of its unsaved wording", async () => {
    renderSettings();
    await waitForHydration();
    await recheck();

    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Cancel (unsaved)" }),
    ).toBeNull();
  });

  it("still warns when a real edit follows a recheck", async () => {
    const { onClose } = renderSettings();
    await waitForHydration();
    await recheck();

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Incident response" },
    });

    fireEvent.click(screen.getByTitle("Close"));

    await waitFor(() => expect(hostMocks.confirm).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});
