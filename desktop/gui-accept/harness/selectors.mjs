/**
 * Production-neutral selectors — exact accessible names from shipped UI copy.
 * Keep in sync with PreLaunchScreen / LogExplorer / NoiseCandidateReview.
 * Structural test (scripts/selector-contract.test.mjs) greps product sources.
 */

export const SEL = {
  // PreLaunchScreen wizard CTAs (exact button text)
  useDefaultFolder: "Use default folder",
  continueToAi: "Continue to AI setup →",
  continueToReady: "Continue to Ready →",
  resetDefaultFolder: "Reset to default folder",
  back: "← Back",
  recheck: "Recheck",

  // Launch / demo 25k
  demoCheckboxName: "Install demo log corpus",
  installDemo: "Install demo",
  demoProgress: "Demo corpus installation progress",
  cancelInstall: "Cancel",
  cancelling: "Cancelling…",
  retryInstall: "Retry installation",
  enterApp: "Enter app",
  enterAppLogs: "Enter app · Open Logs",
  demoInstalled: "Demo installed",
  demoAlready: "Demo already installed",
  installCancelled: "Installation cancelled",

  // Logs library (ellipsis is part of the production button labels)
  importLogs: "Import logs…",
  openExplorer: "Open Explorer…",
  /** Prefer in-app explorer under WebDriver — multi-window is flaky with tauri-driver. */
  openExplorerInApp: "Open in app",
  openExplorerInAppTestId: '[data-testid="open-log-explorer-in-app"]',
  openExplorerTestId: '[data-testid="open-log-explorer"]',

  // Explorer
  logExplorer: '[data-testid="log-explorer"]',
  logExplorerCounts: '[data-testid="log-explorer-global-counts"]',
  logExplorerCountTruth: '[data-testid="log-explorer-count-truth"]',
  logExplorerFacetsLoading: '[data-testid="log-explorer-facets-loading"]',

  // Noise review (product copy)
  reviewSuggestions: "Review suggestions",
  acceptAll: "Accept all",
  suppress: "Suppress…",
  cancelPreview: "Cancel",
  /** Suppress exact template dialog (NoisePolicy). */
  suppressDialogTitle: "Suppress exact template",
  suppressRationaleLabel: "Rationale (required)",
  previewImpact: "Preview impact",
  confirmSuppression: "Confirm suppression",
  suppressionPreviewAria: "Suppression preview",
  /** Product copy proving conservative ERROR handling (NoiseCandidateReview). */
  noiseConservativeErrorCopy: "ERROR/WARN-heavy",
  noiseNoPreselectCopy: "Nothing is preselected",
  redactedRepresentatives: "Redacted representatives",

  // Chat session sidebar + context menu (#837)
  newChat: "New chat",
  chatNavAria: "Chat navigation",
  chatCtxMenu: ".chat-ctx-menu",
  chatCtxMenuItem: ".chat-ctx-menu__item",
  sessionListItem: "button.session-list__item",
  /** Production ChatContextMenu menuitem labels (exact). */
  chatMenuOpen: "Open",
  chatMenuRename: "Rename…",
  chatMenuPin: "Pin to sidebar",
  chatMenuUnpin: "Unpin from sidebar",
  chatMenuArchive: "Open archive",
  chatMenuTrash: "Move to Trash…",
};

/** Ordered wizard advances toward Ready (production labels only). */
export const WIZARD_ADVANCE_LABELS = [
  SEL.useDefaultFolder,
  SEL.continueToAi,
  SEL.continueToReady,
];
