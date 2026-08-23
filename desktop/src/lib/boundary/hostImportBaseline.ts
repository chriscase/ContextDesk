/**
 * Boundary ratchet baseline — measured at branch creation (base bc7e23b2).
 *
 * These are the production (non-test) files that imported `src/lib/host`
 * or a direct `@tauri-apps/*` API when the `@contextdesk/*` package boundary
 * was introduced. They are grandfathered TEMPORARILY: the boundary test
 * (`boundary.test.ts`) fails the suite when any file NOT in these lists (and
 * not inside the designated adapter boundary, `src/lib/engine/`) imports
 * either surface. Files may be REMOVED from these lists as they migrate to
 * `@contextdesk/client`; adding a file requires an explicit review decision.
 *
 * Do not reorder casually — lists are sorted for stable diffs.
 */

/** Production files allowed to import `src/lib/host` (55 at baseline). */
export const HOST_IMPORT_BASELINE: readonly string[] = [
  "src/App.tsx",
  "src/components/Composer.tsx",
  "src/components/PreflightPanel.tsx",
  "src/components/SessionContextBar.tsx",
  "src/components/SourceCitations.tsx",
  "src/components/handbook/EngineeringHandbook.tsx",
  "src/components/handbook/HandbookExport.tsx",
  "src/components/launch/PreLaunchScreen.tsx",
  "src/components/logExplorer/CreateInvestigationItemDialog.tsx",
  "src/components/logExplorer/EvidencePanel.tsx",
  "src/components/logExplorer/ExplorerTimeResolutionDialog.tsx",
  "src/components/logExplorer/LinkedChatRail.tsx",
  "src/components/logExplorer/LogExplorer.tsx",
  "src/components/logExplorer/NoiseCandidateReview.tsx",
  "src/components/logExplorer/NoisePolicy.tsx",
  "src/components/logExplorer/TimelineNavigator.tsx",
  "src/components/logExplorer/VirtualizedEventList.tsx",
  "src/components/panes/ChatArchivePane.tsx",
  "src/components/panes/HarvestPane.tsx",
  "src/components/panes/HelpMarkdown.tsx",
  "src/components/panes/HelpPane.tsx",
  "src/components/panes/LogDiagnosticDialog.tsx",
  "src/components/panes/LogImportConfidence.tsx",
  "src/components/panes/LogPane.tsx",
  "src/components/panes/LogTimezoneReviewDialog.tsx",
  "src/components/panes/LogTimezoneStatus.tsx",
  "src/components/panes/MemoryPane.tsx",
  "src/components/settings/AiSection.tsx",
  "src/components/settings/AiSetupWizard.tsx",
  "src/components/settings/BackupSection.tsx",
  "src/components/settings/CapabilityQualificationPanel.tsx",
  "src/components/settings/ConnectorsSection.tsx",
  "src/components/settings/GeneralSection.tsx",
  // Review decision (investigation-team-readiness): the Settings readiness
  // matrix reads host-owned role assignments and measured status only; it
  // never calls providers or reaches the Tauri API directly.
  "src/components/settings/InvestigationTeamReadinessPanel.tsx",
  "src/components/settings/ModulesSection.tsx",
  "src/components/settings/MultiModelReviewToggle.tsx",
  "src/components/settings/PreflightSection.tsx",
  "src/components/settings/SkillsSection.tsx",
  "src/components/settings/WorkspaceSection.tsx",
  "src/components/settings/useSettingsController.ts",
  "src/components/shell/Banners.tsx",
  "src/components/shell/ChatPane.tsx",
  "src/components/shell/MessageRow.tsx",
  "src/components/shell/UpdateBanner.tsx",
  "src/components/wizards/LogTroubleshootingWizard.tsx",
  "src/hooks/useChatSessions.ts",
  "src/hooks/useLinkedCorpusAttachment.ts",
  "src/hooks/useShellState.ts",
  "src/hooks/useTurnController.ts",
  "src/lib/logDiagnosticReport.ts",
  "src/lib/logExplorer/investigationView.ts",
  "src/lib/logExplorer/lanePaging.ts",
  "src/lib/logExplorer/residentWindow.ts",
  "src/lib/session/dto.ts",
  "src/lib/session/meta.ts",
  "src/lib/session/types.ts",
  "src/lib/turn.ts",
];

/**
 * Production files allowed to import `@tauri-apps/*` directly (5 at
 * baseline). `src/lib/host.ts` is itself the current IPC door and stays
 * listed until it is absorbed by the engine adapter.
 */
export const TAURI_IMPORT_BASELINE: readonly string[] = [
  "src/components/settings/useSettingsController.ts",
  "src/components/shell/Titlebar.tsx",
  "src/lib/dialogs.ts",
  "src/lib/host.ts",
  "src/lib/themeBridge.ts",
  // Review decision (#641, 2026-08-02): cross-window UI-scale sync mirrors
  // themeBridge (grandfathered above) — the Tauri event bus is the only
  // cross-webview channel; the engine boundary does not cover window events.
  "src/lib/uiScaleBridge.ts",
  // Review decision (#875, 2026-08-03): a timezone apply/undo from outside
  // any given Log Explorer (TimeReviewCard on the reviewed-import summary,
  // or LogTimezoneStatus in the Logs pane) must still reach an already-open
  // Explorer, in-app or in its own OS window. Same shape as themeBridge/
  // uiScaleBridge above — the Tauri event bus is the only channel that
  // reaches a separate webview, and the engine boundary doesn't cover it.
  "src/lib/logExplorer/timeRevisionBridge.ts",
  // Review decision (evidence-lane-bridge, 2026-08-04): main-chat / linked-chat
  // Evidence · N "Show in Explorer" must place 1–4 lanes into an already-open
  // log-explorer-* Tauri webview. CustomEvent is same-webview only; same bus
  // pattern as timeRevisionBridge/themeBridge. Persist remains localStorage;
  // emit/listen is signal only (no corpus reimport/mutate).
  "src/lib/logExplorer/evidenceLaneApplyBridge.ts",
];
