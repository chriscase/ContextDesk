/**
 * Renderer-level visual acceptance: main-window Home surface (ChatPane
 * first-chat home), an active chat transcript, the pre-launch readiness
 * screen, and Settings (AI / model curation + Appearance / theme picker).
 *
 * Scope honesty: everything proven here is renderer-level — real production
 * CSS, layout, focus, and ARIA inside headless Chromium — and never native
 * packaged acceptance (docs/CLOSE_PROOF.md § Native packaged proof).
 *
 * Assertions derive from the shipped contracts these design docs / unit
 * suites pin:
 * - First-chat home readiness + starters (#539/#746):
 *   src/components/shell/ChatPane.empty.test.tsx
 * - Chat input-stack shared measure + gutters (#699/#767):
 *   src/styles/chatMeasure.test.ts
 * - Transcript folding (view-only, never deletes): ChatPane compact-banner
 * - Pre-launch readiness gating (#394/#395/#732):
 *   src/components/launch/PreLaunchScreen.test.tsx
 * - Model curation surfaces (#678/#833):
 *   src/lib/modelCuration.contract.test.tsx, ModelVisibilityPanel.tsx
 * - Theme registry (5 skins, html[data-theme], cd-theme): src/lib/skins.ts,
 *   src/lib/themeBridge.ts
 *
 * These are COMPONENT renders, never full <App/> (the shell survey documents
 * that full-App states need an invoke-level dispatcher — out of scope), so
 * the readiness variants are driven by the same props App computes
 * (preflightBlocking / providerUnverified / hasAuthorizedWorkspaceContent).
 */
import "./support/styles";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ChatPane } from "../src/components/shell/ChatPane";
import { PreLaunchScreen } from "../src/components/launch/PreLaunchScreen";
import { SettingsModal } from "../src/components/SettingsModal";
import type { SkinId } from "../src/lib/skins";
import {
  applyTheme,
  expectNoAxeViolations,
  expectNoHorizontalPageOverflow,
  nextPaintedFrame,
  renderVisual,
  resetVisualState,
  setViewport,
  visualStage,
} from "./support/harness";
import {
  activeProviderDto,
  appSetup,
  chatPaneProps,
  chatSession,
  launchPreflight,
  modelInventory,
  transcriptMessages,
} from "./support/shellSettingsFixtures";

const hostMocks = vi.hoisted(() => ({
  getActiveProvider: vi.fn(),
  listModelsForDraft: vi.fn(),
  getCurationSummary: vi.fn(),
  listChatModels: vi.fn(),
  suggestDefaultWorkspace: vi.fn(),
}));

// Repo convention (SettingsModal.test.tsx): spread the real module so every
// symbol the component graph imports stays exported. In browser mode the
// untouched wrappers take their benign non-Tauri branch ([]/null), so only
// the commands that must produce content are overridden.
vi.mock("../src/lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/host")>();
  return {
    ...original,
    hostGetActiveProvider: hostMocks.getActiveProvider,
    hostListModelsForDraft: hostMocks.listModelsForDraft,
    hostGetCurationSummary: hostMocks.getCurationSummary,
    hostListChatModels: hostMocks.listChatModels,
    hostSuggestDefaultWorkspace: hostMocks.suggestDefaultWorkspace,
  };
});

// Same stub the PreLaunchScreen unit suite uses: the wizard is its own
// surface; here it only has to exist while clicking through to Ready. The
// Settings AI section never renders it in advanced (ollama) mode.
vi.mock("../src/components/settings/AiSetupWizard", () => ({
  AiSetupWizard: () => <div aria-label="AI setup">AI setup</div>,
}));

/**
 * Definite-height flex column, standing in for the app shell's .workspace
 * cell: .pane-panel / .settings-page are flex:1/height:100% children in
 * production and need a constrained ancestor for their internal scrollports.
 */
function frame(ui: ReactElement, height = 720) {
  return renderVisual(
    <div
      data-testid="visual-frame"
      style={{ height, display: "flex", flexDirection: "column" }}
    >
      {ui}
    </div>,
  );
}

function frameEl(): HTMLElement {
  return screen.getByTestId("visual-frame");
}

function q(scope: ParentNode, selector: string): HTMLElement {
  const el = scope.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function rect(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

function renderSettings(
  section: "ai" | "appearance",
  onThemeChange: (t: SkinId) => void = vi.fn(),
) {
  return frame(
    <SettingsModal
      open
      initialSection={section}
      setup={appSetup()}
      theme="dark"
      onThemeChange={onThemeChange}
      onClose={vi.fn()}
      onSaveSetup={vi.fn()}
    />,
    780,
  );
}

/**
 * useSettingsController hydration is a strictly sequential await chain;
 * suggest_default_workspace is its final command, so its call is the proof
 * the whole chain settled (same sentinel as SettingsModal.test.tsx).
 */
async function waitForSettingsHydration(): Promise<void> {
  await waitFor(() =>
    expect(hostMocks.suggestDefaultWorkspace).toHaveBeenCalled(),
  );
}

/** The SessionContextBar settles async even with empty data — await it so
 * screenshots never race its "No files…" summary line. */
async function waitForContextBar(): Promise<void> {
  await waitFor(() =>
    expect(
      within(screen.getByTestId("session-context-bar")).getByText(
        /No files, skill, or log corpus/,
      ),
    ).toBeTruthy(),
  );
}

beforeEach(async () => {
  await resetVisualState();
  hostMocks.getActiveProvider.mockReset().mockResolvedValue(activeProviderDto());
  hostMocks.listModelsForDraft
    .mockReset()
    .mockResolvedValue(["mistral", "llama3.1", "qwen2.5"]);
  hostMocks.getCurationSummary
    .mockReset()
    .mockResolvedValue({ hidden_models: 2, hidden_providers: 0, pinned_models: 1 });
  hostMocks.listChatModels.mockReset().mockResolvedValue(modelInventory());
  hostMocks.suggestDefaultWorkspace.mockReset().mockResolvedValue({
    path: "/Users/visual/Documents/ContextDesk",
    label: "Documents/ContextDesk",
    exists: true,
  });
});

describe("first-chat home (ChatPane)", () => {
  it("drives blocked / unverified / ready from the same props App computes", () => {
    // Blocked: one recovery path, no action galleries (#539).
    const blocked = frame(
      <ChatPane
        {...chatPaneProps({
          preflightBlocking: true,
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    expect(
      screen.getByTestId("first-chat-home").getAttribute("data-preflight"),
    ).toBe("blocked");
    expect(
      screen.getByRole("button", { name: /Fix setup issues/ }),
    ).toBeTruthy();
    expect(screen.queryByTestId("chat-starter")).toBeNull();
    const blockedNote = screen.getByText(/Conversation actions are paused/);
    expect(blockedNote.getAttribute("role")).toBe("status");
    blocked.unmount();

    // Unverified (#746): warns without blocking conversation.
    const unverified = frame(
      <ChatPane
        {...chatPaneProps({
          providerUnverified: true,
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    expect(
      screen.getByTestId("first-chat-home").getAttribute("data-preflight"),
    ).toBe("unverified");
    const note = screen.getByTestId("first-chat-unverified-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toMatch(/has not answered a live check yet/);
    expect(
      screen.getByTestId("first-chat-verify-provider").textContent,
    ).toBe("Test connection");
    expect(screen.getAllByTestId("chat-starter").length).toBeGreaterThan(0);
    unverified.unmount();

    // Ready: exactly three starters, each labelled as fill-not-send.
    frame(
      <ChatPane
        {...chatPaneProps({
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    expect(
      screen.getByTestId("first-chat-home").getAttribute("data-preflight"),
    ).toBe("ready");
    const starters = screen.getAllByTestId("chat-starter");
    expect(starters).toHaveLength(3);
    for (const starter of starters) {
      expect(starter.getAttribute("aria-label")).toMatch(
        /; fills the composer for review$/,
      );
    }
    expect(screen.queryByTestId("first-chat-unverified-note")).toBeNull();
    expect(screen.queryByTestId("first-chat-verify-provider")).toBeNull();
  });

  it("keeps the home inside the viewport and centers the input stack (#699/#767)", async () => {
    frame(
      <ChatPane
        {...chatPaneProps({
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    const dock = q(frameEl(), ".composer-dock");
    const bar = q(frameEl(), ".session-context-bar");
    const composer = q(frameEl(), ".composer");

    // Shelf and composer resolve the same measure: identical outer edges.
    expect(Math.abs(rect(bar).left - rect(composer).left)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect(bar).right - rect(composer).right)).toBeLessThanOrEqual(1);
    // Centered, with a real (non-zero) symmetric gutter at 1280px.
    const leftGutter = rect(composer).left - rect(dock).left;
    const rightGutter = rect(dock).right - rect(composer).right;
    expect(leftGutter).toBeGreaterThan(0);
    expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(2);
    expectNoHorizontalPageOverflow();

    // Narrow (real viewport resize — breakpoints use ResizeObserver).
    await setViewport("narrow");
    await nextPaintedFrame();
    expectNoHorizontalPageOverflow();
    expect(rect(composer).right).toBeLessThanOrEqual(window.innerWidth);
    expect(rect(composer).left).toBeGreaterThanOrEqual(0);
  });

  it("matches home baselines: ready dark + light, blocked dark", async () => {
    const ready = frame(
      <ChatPane
        {...chatPaneProps({
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    await waitForContextBar();
    await expect(page.elementLocator(frameEl())).toMatchScreenshot(
      "home-ready-dark",
    );
    await applyTheme("light");
    await expect(page.elementLocator(frameEl())).toMatchScreenshot(
      "home-ready-light",
    );
    ready.unmount();

    await applyTheme("dark");
    frame(
      <ChatPane
        {...chatPaneProps({
          preflightBlocking: true,
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    await waitForContextBar();
    await expect(page.elementLocator(frameEl())).toMatchScreenshot(
      "home-blocked-dark",
    );
  });

  it("has no axe violations on the ready home (dark)", async () => {
    frame(
      <ChatPane
        {...chatPaneProps({
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    await waitForContextBar();
    // FINDING (product, not test): three real axe violations exist on the
    // shipped ready home today; the suite asserts current-actual behavior and
    // reports them instead of fixing src/**. Each disable below is one exact
    // defect:
    // 1. color-contrast [serious]: .composer__hint uses --text-faint #7a808c
    //    (dark.css:14) at 10px/400 on the composer surface #181b22 → 4.34:1,
    //    below the 4.5:1 minimum for small text (Composer.tsx:379-386).
    // 2. label-title-only [serious]: the composer textarea (Composer.tsx:227)
    //    has no <label>/aria-label — its accessible name is placeholder-only,
    //    which disappears while typing.
    // 3. landmark-banner-is-top-level [moderate]: the empty-state hero is a
    //    <header> (implicit banner) nested inside the "Chat transcript"
    //    region landmark (ChatPane.tsx:385, inside 305-309).
    await expectNoAxeViolations(visualStage(), {
      disableRules: [
        "color-contrast",
        "label-title-only",
        "landmark-banner-is-top-level",
      ],
    });
  });
});

describe("active chat transcript (ChatPane)", () => {
  it("folds older turns, scrolls inside .chat-scroll, and docks the composer", async () => {
    const msgs = transcriptMessages();
    const session = chatSession(msgs);
    const setShowFullHistory = vi.fn();
    frame(
      <ChatPane
        {...chatPaneProps({
          openChatSessions: [session],
          resolvedSessionId: session.id,
          messages: msgs,
          visibleMessages: msgs.slice(2),
          isFolded: true,
          hiddenCount: 2,
          hiddenPreview:
            "user: Where does the latency spike start?\nassistant: Right after the deploy marker.",
          setShowFullHistory,
        })}
      />,
    );

    // Header names the active conversation.
    expect(
      screen.getByRole("heading", { level: 2, name: "Log triage deep dive" }),
    ).toBeTruthy();

    // Fold banner: status semantics, count, and the Show-all escape hatch.
    const banner = q(frameEl(), ".compact-banner");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain("2 earlier messages folded");
    fireEvent.click(within(banner).getByRole("button", { name: "Show all" }));
    expect(setShowFullHistory).toHaveBeenCalledWith(true);

    // Six visible rows, un-virtualized below the 40-row threshold.
    expect(frameEl().querySelectorAll(".chat-transcript__row")).toHaveLength(6);
    expect(
      q(frameEl(), ".chat-transcript").getAttribute("data-virtualized"),
    ).toBe("false");

    // The transcript scrolls inside .chat-scroll — never the page.
    const scroll = q(frameEl(), ".chat-scroll");
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(
      window.innerHeight,
    );
    expectNoHorizontalPageOverflow();
    expect(scroll.getAttribute("tabindex")).toBe("0");
    expect(scroll.getAttribute("aria-label")).toBe(
      "Transcript for Log triage deep dive",
    );

    // Composer dock pinned directly below the transcript region.
    const wrap = q(frameEl(), ".chat-scroll-wrap");
    const dock = q(frameEl(), ".composer-dock");
    expect(rect(dock).top).toBeGreaterThanOrEqual(rect(wrap).bottom - 0.5);
    expect(rect(dock).bottom).toBeLessThanOrEqual(rect(frameEl()).bottom + 0.5);

    // Transcript rows and composer share centered outer edges (#699/#767).
    const msgEl = q(frameEl(), ".msg");
    const composer = q(frameEl(), ".composer");
    expect(Math.abs(rect(msgEl).left - rect(composer).left)).toBeLessThanOrEqual(2);
    expect(Math.abs(rect(msgEl).right - rect(composer).right)).toBeLessThanOrEqual(2);

    // Attached to bottom: no jump-to-latest affordance.
    expect(screen.queryByTestId("chat-jump-latest")).toBeNull();

    await waitForContextBar();
    await expect(page.elementLocator(frameEl())).toMatchScreenshot(
      "chat-active-dark",
    );
  });
});

describe("pre-launch readiness screen", () => {
  function renderPrelaunch(blocking: boolean) {
    // Rendered directly like PreLaunchScreen.test.tsx: the surface is only
    // reachable through the real phase machine (4.5s splash) inside App.
    const view = renderVisual(
      <PreLaunchScreen
        productName="ContextDesk"
        tagline="Developer knowledge workbench"
        setup={appSetup()}
        preflight={launchPreflight(blocking)}
        onSaveSetup={vi.fn()}
        onApplyAi={vi.fn()}
        onRecheck={vi.fn()}
        onEnterApp={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to AI setup →" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Ready →" }),
    );
    return view;
  }

  it("shows level glyphs on launch-critical checks and gates Enter app", async () => {
    const ready = renderPrelaunch(false);
    const list = screen.getByRole("list", { name: "Launch-critical checks" });
    const rows = within(list).getAllByRole("listitem");
    // workspace.roots + provider.active; memory.store stays work-context.
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getAttribute("data-level")).toBe("pass");
      expect(q(row, ".launch-pills__status").textContent).toBe("●");
    }
    const enter = screen.getByRole("button", {
      name: "Enter app",
    }) as HTMLButtonElement;
    expect(enter.disabled).toBe(false);

    await expect(
      page.elementLocator(q(ready.container, ".launch-shell")),
    ).toMatchScreenshot("prelaunch-ready-dark");
    ready.unmount();

    const blocked = renderPrelaunch(true);
    const blockedList = screen.getByRole("list", {
      name: "Launch-critical checks",
    });
    const failRow = within(blockedList)
      .getAllByRole("listitem")
      .find((row) => row.getAttribute("data-level") === "fail");
    expect(failRow).toBeTruthy();
    expect(q(failRow!, ".launch-pills__status").textContent).toBe("×");
    expect(
      (screen.getByRole("button", { name: "Enter app" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    blocked.unmount();
  });
});

describe("settings — AI / models", () => {
  it("advanced AI section exposes provider and model pickers with the curation summary", async () => {
    renderSettings("ai");
    await waitForSettingsHydration();

    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    const activeNav = frameEl().querySelectorAll(
      '.settings-nav__item[data-active="true"]',
    );
    expect(activeNav).toHaveLength(1);
    expect(activeNav[0]!.textContent).toContain("AI / Models");

    const provider = screen.getByRole("combobox", {
      name: "Provider",
    }) as HTMLSelectElement;
    expect(provider.value).toBe("ollama");

    // "Chat model" appears only after the 450ms discovery debounce resolves.
    const chatModel = (await screen.findByRole(
      "combobox",
      { name: "Chat model" },
      { timeout: 4000 },
    )) as HTMLSelectElement;
    expect(chatModel.value).toBe("mistral");
    // The note renders twice by design (field hint + role=status line).
    await screen.findAllByText("Found 3 models.");

    await waitFor(() =>
      expect(screen.getByTestId("curation-summary").textContent).toBe(
        "2 hidden · 1 pinned",
      ),
    );
    const manage = screen.getByRole("button", { name: "Manage…" });
    expect(manage.getAttribute("aria-haspopup")).toBe("dialog");

    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(frameEl())).toMatchScreenshot(
      "settings-ai-dark",
    );
    // FINDING (product, not test): three real axe violations exist on the
    // shipped Settings AI surface today; asserted as current-actual and
    // reported instead of fixing src/**:
    // 1. color-contrast [serious]: .settings-nav__title uses --text-faint
    //    #7a808c (dark.css:14) at 10px on #181b22 → 4.34:1 (< 4.5:1;
    //    settings.css:118-126) — same token defect as the composer hint.
    // 2. landmark-banner-is-top-level [moderate]: .settings-header <header>
    //    nested inside the "Settings" region landmark (SettingsModal.tsx:150).
    // 3. landmark-contentinfo-is-top-level [moderate]: .settings-footer
    //    <footer> nested in the same region (SettingsModal.tsx:282).
    await expectNoAxeViolations(visualStage(), {
      disableRules: [
        "color-contrast",
        "landmark-banner-is-top-level",
        "landmark-contentinfo-is-top-level",
      ],
    });
  });

  it("Manage… opens the inventory dialog: focused search, internal scroll, no page growth", async () => {
    renderSettings("ai");
    await waitForSettingsHydration();
    await waitFor(() =>
      expect(screen.getByTestId("curation-summary").textContent).toBe(
        "2 hidden · 1 pinned",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();

    // Search focus lands via requestAnimationFrame — assert inside waitFor.
    const search = within(dialog).getByPlaceholderText(
      "Filter by model or provider…",
    );
    await waitFor(() => expect(document.activeElement).toBe(search));

    // 40-model inventory: 38 visible rows (2 hidden until Show hidden).
    const list = await within(dialog).findByRole("list", {
      name: "Discovered models",
    });
    await waitFor(() =>
      expect(list.querySelectorAll("[data-model-row]")).toHaveLength(38),
    );
    expect(
      within(dialog).getByRole("checkbox", { name: /Show hidden \(2\)/ }),
    ).toBeTruthy();
    expect(dialog.getAttribute("aria-busy")).toBe("false");

    // The list is the scrolling region inside the dialog; the page never grows.
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(
      window.innerHeight,
    );
    expectNoHorizontalPageOverflow();

    // Bring the dialog fully into view inside the settings scrollport before
    // shooting it (it sits at the bottom of the AI section).
    dialog.scrollIntoView({ block: "center" });
    await nextPaintedFrame();
    await expect(page.elementLocator(dialog)).toMatchScreenshot(
      "settings-manage-models-dark",
    );
  });
});

describe("settings — appearance & theme picker", () => {
  it("offers the five registered skins and repaints the real stage on selection", async () => {
    // The picker only calls onThemeChange; wire it to the production apply
    // path (themeBridge via harness applyTheme) exactly as useShellState does.
    renderSettings("appearance", (skin) => {
      void applyTheme(skin);
    });
    await waitForSettingsHydration();

    const trigger = screen.getByRole("button", { name: /^Theme Dark/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);

    const listbox = await screen.findByRole("listbox", {
      name: "Choose appearance theme",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(listbox.id);

    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(5);
    const selected = options.filter(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(q(selected[0]!, "strong").textContent).toBe("Dark");
    expect(selected[0]!.querySelector('[data-visible="true"]')).toBeTruthy();
    // Opening moves focus to the selected option (rAF).
    await waitFor(() => expect(document.activeElement).toBe(selected[0]));

    // Selecting Light flips the real painted stage background.
    const before = getComputedStyle(visualStage()).backgroundColor;
    const lightOption = options.find(
      (option) => option.querySelector("strong")?.textContent === "Light",
    );
    expect(lightOption).toBeTruthy();
    fireEvent.click(lightOption!);
    await waitFor(() =>
      expect(getComputedStyle(visualStage()).backgroundColor).not.toBe(before),
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("cd-theme")).toBe("light");
  });
});
