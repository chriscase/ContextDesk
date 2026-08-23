/** Host bridge: Tauri invoke when available; offline research via test hook. */

import type { AppSetupState } from "./preflight";
import {
  parseCurationImpact,
  parseCurationSummary,
  parseModelOptions,
  type CurationImpactDto,
  type CurationSummaryDto,
  type ModelOptionDto,
  type ModelReadiness,
} from "@contextdesk/contracts";
export { modelSelectionKey, parseModelSelectionKey } from "@contextdesk/contracts";
export type {
  CurationImpactDto,
  CurationSummaryDto,
  ModelOptionDto,
  ModelReadiness,
} from "@contextdesk/contracts";
// Type-only (erased at build time): logDiagnosticReport imports types from here
// as well, so this cannot create a runtime cycle.
import type { LogDiagnosticSuppressionPolicyInput } from "./logDiagnosticReport";
import { publishDeveloperDetail } from "./activity/developerDetailBridge";
import { publishTurnActivityUpdate } from "./activity/turnActivityUpdateBridge";
import type { DeveloperDetailEvent } from "./activity/types";

export type EventDto = {
  kind: string;
  payload: Record<string, unknown>;
};

/**
 * Authoritative OpenAI-compatible provider-turn telemetry (same DTO as CLI
 * `trace_summary.provider_telemetry` / EventDto kind `provider_telemetry`).
 * Hosts must project this value; they must not invent tokens, cost, or route.
 */
export type ProviderTurnTelemetryDto = {
  configuredProfileId: string;
  configuredModel: string;
  responseModel?: string | null;
  providerRequestId?: string | null;
  observedRoute: { status: "unknown" } | { status: "reported"; value: string };
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  totalTokens?: number | null;
  cost?: number | null;
  contextBudget?: Record<string, unknown> | null;
  providerRoundCount: number;
  applicationRetryReasons?: { round: number; reason: string }[];
  finalTurnOutcome?: string | null;
  finishReason?: string | null;
  emptyVisibleAnswer: boolean;
  truncatedByLength: boolean;
  toolCallCount: number;
  latencyMs?: number | null;
  rounds?: Record<string, unknown>[];
};

export type PreflightItemDto = {
  id: string;
  title: string;
  level: "pass" | "warn" | "fail" | "off";
  detail: string;
  fix_action?: string | null;
  category?: "launch" | "work" | "optional";
};

export type PreflightReportDto = {
  items: PreflightItemDto[];
  has_blocking: boolean;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Open an http(s) URL in the **system** default browser.
 * In Tauri, `window.open` does not launch the OS browser — host IPC does.
 */
export async function hostOpenExternalUrl(url: string): Promise<void> {
  const u = url.trim();
  if (!u) return;
  if (!isTauri()) {
    window.open(u, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke<void>("open_external_url", { url: u });
}

export type BrandingDto = {
  name: string;
  slug: string;
  tagline: string;
  version: string;
  protocol: string;
  /** `dev` | `installed` (#338). */
  channel: string;
  git_sha?: string | null;
  git_describe?: string | null;
  identity_line?: string;
};

/** Product identity from Rust host / branding.toml (fallback for browser-only). */
export async function hostGetBranding(): Promise<BrandingDto> {
  if (!isTauri()) {
    return {
      name: "ContextDesk",
      slug: "contextdesk",
      tagline: "Developer knowledge workbench — find, synthesize, remember.",
      version: "0.1.0",
      protocol: "cd.v1",
      channel: "dev",
      git_sha: null,
      git_describe: null,
      identity_line: "v0.1.0 · channel=dev · protocol=cd.v1",
    };
  }
  return invoke<BrandingDto>("get_branding");
}

/** Bundled, read-only Help metadata (#438). */
export type HelpPageSummaryDto = {
  id: string;
  title: string;
  summary: string;
  order: number;
  tags: string[];
};

export type HelpSectionDto = {
  id: string;
  title: string;
  order: number;
  pages: HelpPageSummaryDto[];
};

export type HelpTocEntryDto = {
  level: 2 | 3;
  title: string;
  anchor: string;
};

export type HelpAssetRefDto = {
  path: string;
  alt: string;
  mime: string;
};

export type HelpPageDto = {
  meta: HelpPageSummaryDto & {
    section: string;
    related: string[];
  };
  body: string;
  toc: HelpTocEntryDto[];
  assets: HelpAssetRefDto[];
};

export type HelpSearchHitDto = {
  page_id: string;
  title: string;
  summary: string;
  section: string;
  heading?: string | null;
  anchor?: string | null;
  snippet: string;
  score: number;
  mode: "keyword" | "hybrid";
  citation: string;
};

export type HelpAssetDto = {
  mime: string;
  data_url: string;
};

export async function hostListHelpSections(): Promise<HelpSectionDto[]> {
  if (!isTauri()) return [];
  return invoke<HelpSectionDto[]>("list_help_sections");
}

export async function hostGetHelpPage(id: string): Promise<HelpPageDto> {
  if (!isTauri()) {
    throw new Error("Bundled Help requires the desktop app.");
  }
  return invoke<HelpPageDto>("get_help_page", { id });
}

export async function hostSearchHelpPages(
  query: string,
  limit = 8,
): Promise<HelpSearchHitDto[]> {
  if (!isTauri()) return [];
  return invoke<HelpSearchHitDto[]>("search_help_pages", { query, limit });
}

export async function hostGetHelpAsset(
  pageId: string,
  path: string,
): Promise<HelpAssetDto> {
  if (!isTauri()) {
    throw new Error("Bundled Help requires the desktop app.");
  }
  return invoke<HelpAssetDto>("get_help_asset", { pageId, path });
}

/** Developer-facing handbook. Kept outside the user Help/search/tool index. */
export type HandbookChapterDto = {
  id: string;
  title: string;
};

export type HandbookManifestDto = {
  title: string;
  audience: string;
  chapters: HandbookChapterDto[];
};

export type HandbookPageDto = {
  id: string;
  title: string;
  body: string;
};

export type HandbookLinkDto =
  | { kind: "internal"; pageId: string; anchor?: string | null }
  | { kind: "external"; url: string };

export async function hostOpenEngineeringHandbook(): Promise<string> {
  if (!isTauri()) {
    throw new Error("Engineering handbook requires the desktop app.");
  }
  return invoke<string>("open_engineering_handbook");
}

export async function hostGetHandbookManifest(): Promise<HandbookManifestDto> {
  if (!isTauri()) {
    throw new Error("Engineering handbook requires the desktop app.");
  }
  return invoke<HandbookManifestDto>("get_handbook_manifest");
}

export async function hostGetHandbookPage(
  id: string,
): Promise<HandbookPageDto> {
  if (!isTauri()) {
    throw new Error("Engineering handbook requires the desktop app.");
  }
  return invoke<HandbookPageDto>("get_handbook_page", { id });
}

export async function hostResolveHandbookLink(
  fromPageId: string,
  target: string,
): Promise<HandbookLinkDto> {
  if (!isTauri()) {
    throw new Error("Engineering handbook requires the desktop app.");
  }
  return invoke<HandbookLinkDto>("resolve_handbook_link", {
    fromPageId,
    target,
  });
}

export type HandbookExportScope = "current" | "complete";
export type HandbookExportFormat = "markdown" | "html";

export async function hostExportHandbookDocument(args: {
  path: string;
  scope: HandbookExportScope;
  format: HandbookExportFormat;
  pageId?: string | null;
  renderedHtml?: string | null;
}): Promise<number> {
  if (!isTauri()) {
    throw new Error("Handbook export requires the desktop app.");
  }
  return invoke<number>("export_handbook_document", {
    path: args.path,
    scope: args.scope,
    format: args.format,
    pageId: args.pageId ?? null,
    renderedHtml: args.renderedHtml ?? null,
  });
}

/** Session-scoped context pack entry (#341). */
export type SessionContextEntryDto = {
  rel_path: string;
  name: string;
  size: number;
};

export async function hostSessionContextList(
  sessionId: string,
): Promise<SessionContextEntryDto[]> {
  if (!isTauri()) return [];
  return invoke<SessionContextEntryDto[]>("session_context_list", {
    sessionId,
  });
}

export async function hostSessionContextImportBytes(
  sessionId: string,
  name: string,
  data: number[] | Uint8Array,
): Promise<SessionContextEntryDto> {
  if (!isTauri()) {
    throw new Error("Session context requires the desktop app");
  }
  const bytes = Array.from(data instanceof Uint8Array ? data : data);
  return invoke<SessionContextEntryDto>("session_context_import_bytes", {
    sessionId,
    name,
    data: bytes,
  });
}

export async function hostSessionContextImportZip(
  sessionId: string,
  data: number[] | Uint8Array,
): Promise<SessionContextEntryDto[]> {
  if (!isTauri()) {
    throw new Error("Session context requires the desktop app");
  }
  const bytes = Array.from(data instanceof Uint8Array ? data : data);
  return invoke<SessionContextEntryDto[]>("session_context_import_zip", {
    sessionId,
    data: bytes,
  });
}

export async function hostSessionContextRemove(
  sessionId: string,
  relPath: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("session_context_remove", { sessionId, relPath });
}

export async function hostSessionContextPurge(
  sessionId: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("session_context_purge", { sessionId });
}

async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

/**
 * Run research turn — real agent path via Tauri host.
 *
 * In Tauri: streams each EventDto through a Channel as produced (#108);
 * `onEvent` is invoked per message, and the returned array is the full
 * collected sequence (resolves after the host command completes).
 *
 * Browser / cd-server fallback: batched HTTP only (no Channel) — still
 * calls `onEvent` once per event after the batch arrives, then resolves.
 */
export async function agentTurn(
  sessionId: string,
  text: string,
  forceLocal = false,
  chatModel?: string | null,
  providerProfileId?: string | null,
  onEvent?: (ev: EventDto) => void,
  pinnedSkillId?: string | null,
  logExplorerContext?: LogExplorerTurnContextDto | null,
  retrySynthesisOnly = false,
  transcriptIds?: {
    userMessageId?: string | null;
    assistantMessageId?: string | null;
    /** Sensitive, process-lifetime activity detail for this turn only. */
    developerActivityDetail?: boolean;
    /** Explicit one-turn context selected by the user. */
    userSelection?: string | null;
  },
): Promise<EventDto[]> {
  const req = {
    session_id: sessionId,
    text,
    force_local: forceLocal,
    chat_model: chatModel?.trim() || null,
    provider_profile_id: providerProfileId?.trim() || null,
    pinned_skill_id: pinnedSkillId?.trim() || null,
    log_explorer_context: logExplorerContext ?? null,
    retry_synthesis_only: retrySynthesisOnly,
    client_user_message_id: transcriptIds?.userMessageId?.trim() || null,
    client_assistant_message_id:
      transcriptIds?.assistantMessageId?.trim() || null,
    developer_activity_detail:
      transcriptIds?.developerActivityDetail === true,
    user_selection: transcriptIds?.userSelection?.trim() || null,
  };

  if (!isTauri()) {
    // Browser-only: batched path via local server if present (no Channel).
    try {
      const r = await fetch("http://127.0.0.1:8787/v1/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "default",
          query: text,
          session_id: sessionId,
          force_local: true,
          user_selection: req.user_selection,
        }),
      });
      if (r.ok) {
        const j = await r.json();
        const events = (j.events as EventDto[]) ?? [];
        for (const ev of events) {
          onEvent?.(ev);
        }
        return events;
      }
    } catch {
      /* fall through */
    }
    throw new Error(
      "Agent host unavailable. Run via `npm run tauri:dev` or start cd-server on :8787.",
    );
  }

  const { Channel, invoke: inv } = await import("@tauri-apps/api/core");
  const collected: EventDto[] = [];
  // Tauri 2 Channel: host sends EventDto as each stream event is produced.
  const channel = new Channel<EventDto>((ev) => {
    if (ev.kind === "developer_activity") {
      const event = ev.payload.event as DeveloperDetailEvent | undefined;
      const eventSessionId = String(ev.payload.session_id ?? "");
      const messageId = String(ev.payload.message_id ?? "");
      if (event && eventSessionId === sessionId && messageId) {
        publishDeveloperDetail({ sessionId: eventSessionId, messageId, event });
      }
      // Sensitive developer payloads never enter the ordinary event batch or
      // transcript reducer. They have a dedicated process-local bridge.
      return;
    }
    if (ev.kind === "activity_settled") {
      // The host just published this turn's activity record (ordinary
      // and/or developer detail) into its process-lifetime store. Tell
      // ChatPane so it replaces a cached placeholder ("not recorded by
      // host" / stale-pending) immediately, on the real emit path — not
      // only after a late permission decision (completePermission below).
      const eventSessionId = String(ev.payload.session_id ?? "");
      if (eventSessionId === sessionId) {
        publishTurnActivityUpdate({ sessionId: eventSessionId });
      }
      return;
    }
    collected.push(ev);
    onEvent?.(ev);
  });
  await inv<void>("agent_turn", {
    req,
    onEvent: channel,
  });
  return collected;
}

/** Cooperative cancel for an in-flight agent turn (#109). */
export async function hostCancelTurn(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("cancel_turn", { sessionId });
}

export async function completePermission(
  requestId: string,
  decision: "deny" | "allow_once" | "allow_session_path",
  toolName: string,
  argumentsJson: Record<string, unknown>,
  typed?: string,
  sessionId?: string | null,
): Promise<EventDto[]> {
  if (!isTauri()) {
    throw new Error("Permission grants require Tauri host");
  }
  const events = await invoke<EventDto[]>("complete_permission_cmd", {
    req: {
      request_id: requestId,
      decision,
      typed: typed ?? null,
      tool_name: toolName,
      arguments: argumentsJson,
      // So grant outcome is appended to this session's model history (#111).
      session_id: sessionId?.trim() || null,
    },
  });
  const owner = sessionId?.trim();
  if (owner) void publishTurnActivityUpdate({ sessionId: owner });
  return events;
}

export async function hostPreflight(): Promise<PreflightReportDto | null> {
  if (!isTauri()) return null;
  return invoke<PreflightReportDto>("run_preflight_cmd");
}

/** Harvest provenance row (#326). */
export type HarvestRowDto = {
  id: string;
  system: string;
  remoteId: string;
  space?: string | null;
  url?: string | null;
  transform: string;
  syncStatus: string;
  destination: string;
  lastSyncedAt: number;
  remoteVersion?: number | null;
  /** raw_storage only — else paste body_storage (K16). */
  canPublishFromLocal?: boolean;
};

export async function hostListHarvests(limit = 100): Promise<HarvestRowDto[]> {
  if (!isTauri()) return [];
  return invoke<HarvestRowDto[]>("list_harvests", { limit });
}

/** Source-run git status for guided update (#340). */
export type SourceGitStatusDto = {
  isGitRepo: boolean;
  path?: string | null;
  remote?: string | null;
  remoteUrl?: string | null;
  branch?: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  summary: string;
  rebuildHint: string;
  /** False when not a proven ContextDesk product checkout. */
  fetchAllowed: boolean;
};

export async function hostSourceGitStatus(): Promise<SourceGitStatusDto | null> {
  if (!isTauri()) return null;
  return invoke<SourceGitStatusDto>("source_git_status");
}

/** Explicit fetch only — never pull/reset (#340). */
export async function hostSourceGitFetch(): Promise<SourceGitStatusDto> {
  if (!isTauri()) {
    throw new Error("Source git fetch requires Tauri host");
  }
  return invoke<SourceGitStatusDto>("source_git_fetch");
}

/**
 * Propose HardWrite Confluence update for a harvest (#326 PR8).
 * Returns permission_required events; complete via completePermission + type WRITE.
 */
export async function hostProposeConfluencePublish(args: {
  harvestId: string;
  bodyStorageOverride?: string;
  title?: string;
}): Promise<EventDto[]> {
  if (!isTauri()) {
    throw new Error("Confluence publish requires Tauri host");
  }
  // Tauri 2 IPC converts camelCase JS keys → snake_case Rust params.
  return invoke<EventDto[]>("propose_confluence_publish", {
    harvestId: args.harvestId,
    bodyStorageOverride: args.bodyStorageOverride ?? null,
    title: args.title ?? null,
  });
}

export async function hostCheckOllama(
  baseUrl: string,
): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("check_ollama", { baseUrl });
}

export async function hostSetWorkspace(
  name: string,
  roots: string[],
): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_workspace_roots", { name, roots });
}

export type HostConfigDto = {
  workspace?: { id: string; name: string; roots: string[] } | null;
  theme?: string;
};

/** Load non-secret app config from host (hydrate workspace roots). */
export async function hostGetConfig(): Promise<HostConfigDto | null> {
  if (!isTauri()) return null;
  return invoke<HostConfigDto>("get_config");
}

/** Non-secret reviewer candidate row: identity only, no credentials. */
export type ReviewerCandidateDto = {
  id: string;
  label: string;
  chat_model: string;
  /** Local-only profiles cannot egress; no remote acknowledgement applies. */
  local_only: boolean;
};

/**
 * Measured reviewer qualification, from the host's cached JsonProposal
 * capability verdict (a cache peek — reading settings never starts a probe).
 * `unverified` is never qualified.
 */
export type ReviewerQualification =
  | "qualified"
  | "unqualified"
  | "unverified"
  | "unconfigured";

export type ContributionRole =
  | "observation_extractor"
  | "timeline_analyst"
  | "causal_proposer"
  | "contradiction_checker"
  | "evidence_gap"
  | "reviewer";

export type ContributionAssignmentDto = {
  role: ContributionRole;
  profile_id: string;
  model: string | null;
  allow_remote: boolean;
  require_qualified: boolean;
  qualification: ReviewerQualification | string;
};

export type ContributionPolicyDto = {
  max_contributors: number;
  max_parallel: number;
  max_rounds: number;
  max_context_chars: number;
  max_total_provider_rounds: number;
  max_semantic_corrections_per_stage: number;
  max_context_chars_total: number | null;
};

/** Non-secret multi-model settings for the Settings surface. */
export type MultiModelSettingsDto = {
  mode: "single" | "review" | "contributions" | string;
  reviewer_profile_id: string | null;
  reviewer_model: string | null;
  reviewer_allow_remote: boolean;
  reviewer_require_qualified: boolean;
  reviewer_qualification: ReviewerQualification | string;
  /** Active (investigator) profile id, for honest same-profile copy. */
  active_profile_id: string | null;
  /** Existing provider profiles the reviewer role may reference. */
  candidate_profiles: ReviewerCandidateDto[];
  contribution_assignments: ContributionAssignmentDto[];
  contribution_policy: ContributionPolicyDto;
};

export async function hostGetMultiModelSettings(): Promise<MultiModelSettingsDto | null> {
  if (!isTauri()) return null;
  return invoke<MultiModelSettingsDto>("get_multi_model_settings");
}

export async function hostSetMultiModelMode(
  mode: "single" | "review" | "contributions",
): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_multi_model_mode", { mode });
}

/**
 * Assign (or clear, via null/blank profileId) the multi-model reviewer role.
 * Records configuration only — never starts a probe, never runs a turn. The
 * host rejects unknown profiles and a remote acknowledgement on a local-only
 * profile without writing anything. Measured qualification is mandatory:
 * there is deliberately no way to relax `require_qualified` over IPC — every
 * assigned reviewer is recorded with it `true`.
 */
export async function hostSetMultiModelReviewer(args: {
  profileId: string | null;
  model: string | null;
  allowRemote: boolean;
}): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_multi_model_reviewer", args);
}

/**
 * Save the complete contribution team and its hard route budget. This records
 * configuration only; the host still re-checks measured qualification,
 * egress, credentials, and bounds before every linked investigation turn.
 */
export async function hostSetMultiModelContributors(args: {
  assignments: Array<{
    role: ContributionRole;
    profileId: string;
    model: string | null;
    allowRemote: boolean;
  }>;
  policy: {
    maxContributors: number;
    maxParallel: number;
    maxRounds: number;
    maxContextChars: number;
    maxTotalProviderRounds: number;
    maxSemanticCorrectionsPerStage: number;
    maxContextCharsTotal: number | null;
  };
}): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("set_multi_model_contributors", args);
}

/** Non-secret S3-compatible backup settings. Credential values never cross IPC. */
export type S3BackupSettingsDto = {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  path_style: boolean;
  allow_private_network: boolean;
  credentials_present: boolean;
  keychain_service: string;
  access_key_ref: string;
  secret_key_ref: string;
  session_token_ref: string;
};

export type S3BackupProgressDto = {
  phase:
    | "planning"
    | "awaiting_confirmation"
    | "uploaded"
    | "skipped"
    | "manifest_published";
  completed_files: number;
  total_files: number;
  completed_bytes: number;
  total_bytes: number;
};

export type S3BackupRunSummaryDto = {
  status: "declined" | "dry_run" | "completed" | "failed" | "cancelled";
  uploaded_files: number;
  uploaded_bytes: number;
  skipped_files: number;
  skipped_bytes: number;
  excluded_files: number;
  excluded_bytes: number;
  exclusion_reasons: {
    reason:
      | "git_internal"
      | "build_output"
      | "context_desk_internal"
      | "secret_or_credential"
      | "internal_store_or_log"
      | "symlink"
      | "symlink_escape"
      | "unreadable"
      | "file_limit";
    files: number;
    bytes: number;
  }[];
  failed_files: number;
  failed_bytes: number;
  failure:
    | "authorization"
    | "endpoint_policy"
    | "timeout"
    | "transport"
    | "local_io"
    | "invalid_input"
    | null;
};

export async function hostGetS3BackupSettings(): Promise<S3BackupSettingsDto | null> {
  if (!isTauri()) return null;
  return invoke<S3BackupSettingsDto>("get_s3_backup_settings");
}

export async function hostSaveS3BackupSettings(
  req: Pick<
    S3BackupSettingsDto,
    | "enabled"
    | "endpoint"
    | "region"
    | "bucket"
    | "prefix"
    | "path_style"
    | "allow_private_network"
  >,
): Promise<S3BackupSettingsDto> {
  if (!isTauri()) throw new Error("S3 backup settings require the desktop app");
  return invoke<S3BackupSettingsDto>("save_s3_backup_settings", { req });
}

export async function hostRunS3WorkspaceBackup(
  dryRun: boolean,
): Promise<S3BackupRunSummaryDto> {
  if (!isTauri())
    throw new Error("S3 workspace backup requires the desktop app");
  return invoke<S3BackupRunSummaryDto>("run_s3_workspace_backup", { dryRun });
}

export async function hostCancelS3WorkspaceBackup(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("cancel_s3_workspace_backup");
}

export async function hostListenS3BackupProgress(
  onProgress: (progress: S3BackupProgressDto) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<S3BackupProgressDto>("s3-backup-progress", (event) =>
    onProgress(event.payload),
  );
}

/** Workspace connector registry entry (#127). No secrets. */
export type ConnectorDto = {
  id: string;
  kind: string;
  enabled: boolean;
  label: string;
  /** Non-secret kind settings (MCP command/args, etc.). */
  settings?: Record<string, unknown>;
  /** Tools discovered after host attach (MCP names like mcp__server__tool). */
  discovered_tools?: string[];
};

export async function hostListConnectors(): Promise<ConnectorDto[]> {
  if (!isTauri()) return [];
  return invoke<ConnectorDto[]>("list_connectors");
}

export async function hostListConnectorKinds(): Promise<string[]> {
  if (!isTauri()) {
    return [
      "files",
      "memory",
      "sqlite",
      "postgres",
      "mcp",
      "http",
      "confluence",
    ];
  }
  return invoke<string[]>("list_connector_kinds");
}

/** Store connector secret in keychain (Postgres password). Bool-only status via has. */
export async function hostSetConnectorSecret(
  connectorId: string,
  kind: "postgres_password" | "password" | "http_bearer" | "bearer",
  secret: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_connector_secret", {
    connectorId,
    kind,
    secret,
  });
}

export async function hostConnectorHasSecret(
  connectorId: string,
  kind:
    | "postgres_password"
    | "password"
    | "http_bearer"
    | "bearer" = "postgres_password",
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("connector_has_secret", { connectorId, kind });
}

/** Persist connector list (id/kind/enabled/settings only). Rebuilds host. */
export async function hostSaveConnectors(
  connectors: {
    id: string;
    kind: string;
    enabled: boolean;
    settings?: unknown;
  }[],
): Promise<ConnectorDto[]> {
  if (!isTauri()) {
    return connectors.map((c) => ({
      id: c.id,
      kind: c.kind,
      enabled: c.enabled,
      label: c.kind,
      settings: (c.settings as Record<string, unknown>) ?? {},
    }));
  }
  return invoke<ConnectorDto[]>("save_connectors", {
    connectors: connectors.map((c) => ({
      id: c.id,
      kind: c.kind,
      enabled: c.enabled,
      settings: c.settings ?? {},
    })),
  });
}

/** Instant exists + readable directory check (Tauri host). */
export async function hostValidateWorkspacePath(
  path: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!isTauri()) {
    if (!path.trim()) return { ok: false, detail: "Path is empty" };
    return { ok: true, detail: "Browser mode — host will recheck under Tauri" };
  }
  try {
    const detail = await invoke<string>("validate_workspace_path", { path });
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export type DefaultWorkspaceDto = {
  path: string;
  label: string;
  exists: boolean;
};

/** OS Documents/<product> suggestion (does not create the folder). */
export async function hostSuggestDefaultWorkspace(): Promise<DefaultWorkspaceDto | null> {
  if (!isTauri()) return null;
  return invoke<DefaultWorkspaceDto>("suggest_default_workspace");
}

/** Create Documents/<product> if needed and return its path. */
export async function hostEnsureDefaultWorkspace(): Promise<DefaultWorkspaceDto | null> {
  if (!isTauri()) return null;
  return invoke<DefaultWorkspaceDto>("ensure_default_workspace");
}

export async function hostSaveSecret(
  profileId: string,
  secret: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_provider_secret", { profileId, secret });
}

export async function hostProviderHasSecret(
  profileId: string,
): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("provider_has_secret", { profileId });
}

export type LocalCandidateDto = {
  id: string;
  label: string;
  kind: string;
  base_url: string | null;
  credentials_present: boolean;
  notes: string[];
};

/** Local AI candidates (no secrets — presence flags only). */
export async function hostListLocalCandidates(): Promise<LocalCandidateDto[]> {
  if (!isTauri()) {
    return [
      {
        id: "ollama-local",
        label: "Ollama (local)",
        kind: "ollama",
        base_url: "http://127.0.0.1:11434",
        credentials_present: false,
        notes: ["Browser mode stub"],
      },
    ];
  }
  return invoke<LocalCandidateDto[]>("list_local_candidates");
}

export async function hostProbeUrl(
  baseUrl: string,
  allowPrivate = false,
): Promise<{
  ok: boolean;
  effective_base: string;
  candidates: string[];
  error?: string | null;
}> {
  if (!isTauri()) {
    return {
      ok: false,
      effective_base: baseUrl,
      candidates: [],
      error: "Requires Tauri host",
    };
  }
  return invoke("probe_url", {
    req: { base_url: baseUrl, allow_private: allowPrivate },
  });
}

export type ProviderDto = {
  id: string;
  kind: string;
  base_url: string;
  chat_model: string;
  label: string;
  api_key_ref: string | null;
  api_key_file_path?: string | null;
  has_key: boolean;
  /** Native tool calling; false after gateway rejection (#327). */
  tools_enabled?: boolean;
  /** Provider/profile deadline class; auto performs no network probing. */
  deadline_preference?: "auto" | "patient" | "standard";
};

/** Persist an active provider plus an explicit Keychain or protected-file credential source. */
export type SkillDto = {
  id: string;
  name: string;
  description: string;
  disabled: boolean;
  allows_write: boolean;
  path: string;
  /** Sibling module.toml present (#137). */
  has_module: boolean;
  module_id: string | null;
};

export type SetSkillEnabledResult = {
  id: string;
  enabled: boolean;
  needs_module_approval: boolean;
  module_id: string | null;
  preview: string | null;
  reason: string | null;
  type_confirm_phrase: string | null;
};

export async function hostListSkills(): Promise<SkillDto[]> {
  if (!isTauri()) return [];
  return invoke<SkillDto[]>("list_skills_cmd");
}

/** Persist enable/disable; may return module capability approval for tool-shipping skills (#137). */
export async function hostSetSkillEnabled(
  id: string,
  enabled: boolean,
): Promise<SetSkillEnabledResult> {
  if (!isTauri()) throw new Error("Skill enable requires Tauri host");
  return invoke<SetSkillEnabledResult>("set_skill_enabled_cmd", {
    id,
    enabled,
  });
}

/** SoftWrite path: returns permission_required events until grant + re-execute. */
export async function hostProposeSaveSkill(args: {
  id: string;
  name: string;
  description: string;
  body: string;
  allowsWrite?: boolean;
}): Promise<EventDto[]> {
  if (!isTauri()) {
    throw new Error("Skill authoring requires Tauri host");
  }
  return invoke<EventDto[]>("propose_save_skill_cmd", {
    id: args.id,
    name: args.name,
    description: args.description,
    body: args.body,
    allowsWrite: args.allowsWrite ?? false,
  });
}

export async function hostSaveActiveProvider(args: {
  kind: string;
  baseUrl: string;
  chatModel: string;
  label?: string;
  /** Raw key once; never stored in React setup / localStorage after save. */
  apiKey?: string;
  /** Absolute mode-600 credential file path; the host reads it directly. */
  apiKeyFile?: string;
  localOnly?: boolean;
  /** When set, updates native tools capability (#327). */
  toolsEnabled?: boolean;
  /** Explicit latency class for adaptive phase deadlines. */
  deadlinePreference?: "auto" | "patient" | "standard";
}): Promise<ProviderDto | null> {
  if (!isTauri()) return null;
  return invoke<ProviderDto>("save_active_provider", {
    req: {
      kind: args.kind,
      base_url: args.baseUrl,
      chat_model: args.chatModel,
      label: args.label ?? null,
      api_key: args.apiKey ?? null,
      api_key_file: args.apiKeyFile ?? null,
      local_only: args.localOnly ?? null,
      tools_enabled: args.toolsEnabled ?? null,
      deadline_preference: args.deadlinePreference ?? null,
    },
  });
}

/** Stable profile ids used by the host for keychain refs. */
export function profileIdForKind(kind: string): string {
  if (kind === "ollama") return "ollama-local";
  if (kind === "openai_compatible") return "openai-compatible";
  if (kind === "anthropic") return "anthropic";
  if (kind === "xai_grok_build") return "xai-grok-build";
  return kind;
}

/** Normalize host/discovery kind strings into AppSetup providerKind. */
export function normalizeProviderKind(
  kind: string,
): "ollama" | "openai_compatible" | "anthropic" | "xai_grok_build" | "none" {
  const k = kind.trim().toLowerCase().replace(/-/g, "_");
  if (k === "ollama") return "ollama";
  if (k === "openai_compatible" || k === "openaicompatible")
    return "openai_compatible";
  if (k === "anthropic") return "anthropic";
  if (
    k === "xai_grok_build" ||
    k === "xaigrokbuild" ||
    k === "grok" ||
    k === "xai"
  ) {
    return "xai_grok_build";
  }
  return "none";
}

export async function hostReadFile(path: string): Promise<string> {
  if (!isTauri()) {
    // cd-server fallback: not implemented for arbitrary files; fail honestly
    throw new Error("File read requires Tauri host (npm run tauri:dev)");
  }
  return invoke<string>("read_workspace_file_cmd", { path });
}

/** Per-response generation provenance (footer). */
export type MessageMetaDto = {
  model?: string;
  provider_label?: string;
  provider_id?: string;
  base_url?: string;
  provider_kind?: string;
  /** Model requested at send (client snapshot) when host fact is missing. */
  requested_model?: string;
  /**
   * True when `model` came from a host `turn_started` event (not send-time guess).
   * Footer uses honest "requested:" label when false (#155).
   */
  host_confirmed?: boolean;
};

/** Durable chat session (host Session JSON). */
export type StoredMessageDto = {
  id: string;
  role: string;
  content: string;
  tools?: unknown;
  citations?: unknown;
  trail?: string[] | null;
  meta?: MessageMetaDto | null;
};

export type ChatSessionDto = {
  id: string;
  title: string;
  messages: StoredMessageDto[];
  compact_summary?: string | null;
  compact_keep_last: number;
  show_full_history: boolean;
  created_at: string;
  updated_at: string;
  archived: boolean;
  trashed?: boolean;
  trashed_at?: string | null;
  pinned: boolean;
  title_locked: boolean;
  chat_model?: string | null;
  provider_profile_id?: string | null;
  last_read_message_id?: string | null;
  /** Session-pinned skill id (#343). */
  pinned_skill_id?: string | null;
  /** Linked log analysis corpus (#480 Log Explorer). */
  linked_corpus_id?: string | null;
};

/**
 * List selectable chat models.
 *
 * Ordinary pickers call this with no arguments and never receive curated-away
 * choices. Pass `keepKeys` with the conversation's current selection so a chat
 * already pinned to a hidden model still renders it honestly, and
 * `includeHidden` only from the management surface (#678).
 */
export async function hostListChatModels(opts?: {
  includeHidden?: boolean;
  keepKeys?: readonly string[];
}): Promise<ModelOptionDto[]> {
  if (!isTauri()) return [];
  const value = await invoke<unknown>("list_chat_models", {
    includeHidden: opts?.includeHidden ?? false,
    keepKeys: opts?.keepKeys ? [...opts.keepKeys] : [],
  });
  return parseModelOptions(value);
}

/** Counts for the Settings entry point. Config-only: never lists or discovers. */
export async function hostGetCurationSummary(): Promise<CurationSummaryDto | null> {
  if (!isTauri()) return null;
  return parseCurationSummary(await invoke<unknown>("get_curation_summary"));
}

/** Preview what hiding a provider (or one model) would do before writing. */
export async function hostPreviewCurationChange(args: {
  providerId: string;
  modelId?: string | null;
  hidden: boolean;
}): Promise<CurationImpactDto | null> {
  if (!isTauri()) return null;
  return parseCurationImpact(
    await invoke<unknown>("preview_curation_change", {
      providerId: args.providerId,
      modelId: args.modelId ?? null,
      hidden: args.hidden,
    }),
  );
}

/**
 * Hide or restore one exact model. When the change would take the default out
 * of ordinary pickers the host refuses unless `acceptReplacement` is the exact
 * key the preview returned.
 */
export async function hostSetModelHidden(args: {
  providerId: string;
  modelId: string;
  hidden: boolean;
  acceptReplacement?: string | null;
  expectedStateToken?: string | null;
}): Promise<CurationImpactDto | null> {
  if (!isTauri()) return null;
  return parseCurationImpact(
    await invoke<unknown>("set_model_hidden", {
      providerId: args.providerId,
      modelId: args.modelId,
      hidden: args.hidden,
      acceptReplacement: args.acceptReplacement ?? null,
      expectedStateToken: args.expectedStateToken ?? null,
    }),
  );
}

/** Hide or restore a whole provider profile. Deletes nothing. */
export async function hostSetProviderHidden(args: {
  providerId: string;
  hidden: boolean;
  acceptReplacement?: string | null;
  expectedStateToken?: string | null;
}): Promise<CurationImpactDto | null> {
  if (!isTauri()) return null;
  return parseCurationImpact(
    await invoke<unknown>("set_provider_hidden", {
      providerId: args.providerId,
      hidden: args.hidden,
      acceptReplacement: args.acceptReplacement ?? null,
      expectedStateToken: args.expectedStateToken ?? null,
    }),
  );
}

/** Pin or unpin one model in the explicit picker order. */
export async function hostSetModelPinned(args: {
  providerId: string;
  modelId: string;
  pinned: boolean;
}): Promise<boolean> {
  if (!isTauri()) return args.pinned;
  return invoke<boolean>("set_model_pinned", {
    providerId: args.providerId,
    modelId: args.modelId,
    pinned: args.pinned,
  });
}

/** Retry or disable native tools for one exact provider/model pair (#650). */
export async function hostSetModelToolsEnabled(args: {
  providerId: string;
  modelId: string;
  toolsEnabled: boolean;
}): Promise<boolean> {
  if (!isTauri()) return args.toolsEnabled;
  return invoke<boolean>("set_model_tools_enabled", {
    providerId: args.providerId,
    modelId: args.modelId,
    toolsEnabled: args.toolsEnabled,
  });
}

/**
 * Discover model ids for the Settings draft (URL/key not necessarily saved yet).
 * Returns [] when the host cannot list (offline, bad URL, missing key).
 */
export async function hostListModelsForDraft(args: {
  kind: string;
  baseUrl: string;
  apiKey?: string | null;
  apiKeyFile?: string | null;
  localOnly?: boolean | null;
  chatModel?: string | null;
}): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<string[]>("list_models_for_draft", {
      req: {
        kind: args.kind,
        base_url: args.baseUrl,
        api_key: args.apiKey ?? null,
        api_key_file: args.apiKeyFile ?? null,
        local_only: args.localOnly ?? null,
        chat_model: args.chatModel ?? null,
      },
    });
  } catch {
    return [];
  }
}

/** TriageTool-parity native gateway probe (plain HTTP, multi-path). */
export type AiProbeResultDto = {
  ok: boolean;
  flavor: string | null;
  base_url: string;
  effective_base_url: string;
  models: { id: string; kind: string; source: string }[];
  chat_candidates: { id: string; kind: string; source: string }[];
  embed_candidates: { id: string; kind: string; source: string }[];
  notes: string[];
  errors: string[];
  local_ollama_reachable: boolean;
  local_ollama_models: { id: string; kind: string; source: string }[];
};

export async function hostProbeAiGateway(args: {
  baseUrl: string;
  apiKey?: string | null;
  apiKeyFile?: string | null;
  /** Default true — also probe local Ollama. */
  probeLocal?: boolean;
}): Promise<AiProbeResultDto | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<AiProbeResultDto>("probe_ai_gateway_cmd", {
      req: {
        base_url: args.baseUrl,
        api_key: args.apiKey ?? null,
        api_key_file: args.apiKeyFile ?? null,
        probe_local: args.probeLocal ?? true,
      },
    });
  } catch {
    return null;
  }
}

/** Saved active provider (URL + model + key presence; no secret). */
export async function hostGetActiveProvider(): Promise<ProviderDto | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ProviderDto | null>("get_active_provider");
  } catch {
    return null;
  }
}

/** Re-enable or force-disable native tools on a provider profile (#327). */
export async function hostSetProviderToolsEnabled(
  toolsEnabled: boolean,
  profileId?: string | null,
): Promise<ProviderDto | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ProviderDto>("set_provider_tools_enabled", {
      profileId: profileId ?? null,
      toolsEnabled,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capability qualification (#724) — user-triggered; never auto-run
// ---------------------------------------------------------------------------

export type CapabilityCheckDto = {
  kind: string;
  status: "pass" | "degraded" | "fail" | "untested" | string;
  elapsed_ms: number;
  tested_at: number;
  reason: string;
  /** Exact request-mode identity (plain, prompted_json, json_object, …). */
  request_mode?: string | null;
  /** Backend dialect (openai_compatible, ollama, anthropic). */
  dialect?: string | null;
  /** Schema strictness when a json_schema probe was measured. */
  schema_strict?: boolean | null;
  /** Schema probe name identity — never a schema body. */
  schema_probe_id?: string | null;
};

export type ContractVerdict =
  | "qualified"
  | "unqualified"
  | "inconclusive"
  | string;

/** Shared provider-neutral execution projection from the Rust host. */
export type CapabilityContractProjection = {
  host_grounded_generation: ContractVerdict;
  /** Prompted JSON over plain chat (production reviewer path). */
  validated_structured_proposal: ContractVerdict;
  /** Native OpenAI json_object — never authorized by prompted JSON. */
  native_json_object?: ContractVerdict;
  native_json_schema?: ContractVerdict;
  native_json_schema_strict?: ContractVerdict;
  native_tool_loop: ContractVerdict;
  forced_tool_loop?: ContractVerdict;
};

export type QualificationReportDto = {
  profile_id: string;
  endpoint_fingerprint: string;
  model_id: string;
  schema_version: string;
  /** Typed transport protocol (openai_compatible / ollama / anthropic). */
  transport_protocol?: string;
  role_hint: string;
  cancelled: boolean;
  stale: boolean;
  finished_at: number;
  readiness: ModelReadiness;
  contracts: CapabilityContractProjection;
  checks: CapabilityCheckDto[];
};

export type QualificationSelectArgs = {
  profileId?: string | null;
  modelId?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
};

function qualificationReq(
  args: QualificationSelectArgs = {},
  includeApiKey = false,
) {
  return {
    profile_id: args.profileId ?? null,
    model_id: args.modelId ?? null,
    base_url: args.baseUrl ?? null,
    ...(includeApiKey ? { api_key: args.apiKey ?? null } : {}),
  };
}

/** Cached report only (no network / no probes). */
export async function hostGetCapabilityQualification(
  args: QualificationSelectArgs = {},
): Promise<QualificationReportDto | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<QualificationReportDto | null>(
      "get_capability_qualification",
      { req: qualificationReq(args) },
    );
  } catch {
    return null;
  }
}

/** Explicit start of synthetic probes against the configured provider. */
export async function hostStartCapabilityQualification(
  args: QualificationSelectArgs = {},
): Promise<QualificationReportDto> {
  if (!isTauri()) {
    throw new Error("Capability qualification requires the desktop host");
  }
  return invoke<QualificationReportDto>("start_capability_qualification", {
    req: qualificationReq(args, true),
  });
}

/** Cooperative cancel for an in-flight qualification run. */
export async function hostCancelCapabilityQualification(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("cancel_capability_qualification");
  } catch {
    return false;
  }
}

/** Clear cached result for the exact selected model only. */
export async function hostClearCapabilityQualification(
  args: QualificationSelectArgs = {},
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("clear_capability_qualification", {
      req: qualificationReq(args),
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Investigation Team qualification report bridge — read-only renderer side
// ---------------------------------------------------------------------------

export type InvestigationQualificationAxisDto = {
  contract_met: boolean;
  metrics: Record<string, number>;
  notes: string[];
};

export type InvestigationTeamAttemptFailureDto = {
  attempt_id: string;
  role: string;
  reason: string;
};

export type InvestigationTeamMemberDto = {
  role: string;
  subject_storage_id: string;
  profile_id: string;
  model_id: string;
  endpoint_fingerprint: string;
};

export type InvestigationTeamQualificationDto = {
  /** Provider-free wiring check versus a measured configured-provider run. */
  run_kind: "synthetic" | "measured" | string;
  status: "qualified" | "failed" | "partial" | "stale" | string;
  schema_id: string;
  suite_version: string;
  observed_at: number;
  stale: boolean;
  incomplete_attempts: boolean;
  fingerprint_digest: string;
  scoring_digest: string;
  capability: InvestigationQualificationAxisDto;
  quality: InvestigationQualificationAxisDto;
  speed: InvestigationQualificationAxisDto;
  resource: InvestigationQualificationAxisDto;
  /** Exact non-secret identities captured by the host for this report. */
  members?: InvestigationTeamMemberDto[];
  /** Older process-local reports may omit this field; absence means none. */
  failures?: InvestigationTeamAttemptFailureDto[];
  redacted_json: string;
  redacted_markdown: string;
};

/** Latest measured report (or synthetic only when no measured history exists). */
export async function hostGetInvestigationTeamQualification(): Promise<InvestigationTeamQualificationDto | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<InvestigationTeamQualificationDto | null>(
      "get_investigation_team_qualification",
    );
  } catch {
    return null;
  }
}

/** Read bounded durable redacted history; no provider call or credential read. */
export async function hostListInvestigationTeamQualifications(): Promise<InvestigationTeamQualificationDto[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<InvestigationTeamQualificationDto[]>(
      "list_investigation_team_qualifications",
    );
  } catch {
    return [];
  }
}

/** Clear only redacted team history; configuration and role evidence remain. */
export async function hostClearInvestigationTeamQualification(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("clear_investigation_team_qualification");
  } catch {
    return false;
  }
}

/**
 * Run the explicit local synthetic contract check. The trusted host derives
 * members from saved settings and uses an opaque fixture; this never contacts
 * a provider and is not evidence of real model execution.
 */
export async function hostRunSyntheticInvestigationTeamQualification(): Promise<InvestigationTeamQualificationDto> {
  if (!isTauri()) {
    throw new Error("Synthetic qualification requires the trusted desktop host");
  }
  return invoke<InvestigationTeamQualificationDto>(
    "run_synthetic_investigation_team_qualification",
  );
}

/** Run a user-triggered provider-backed check through the trusted host. */
export async function hostRunLiveInvestigationTeamQualification(): Promise<InvestigationTeamQualificationDto> {
  if (!isTauri()) {
    throw new Error("Measured qualification requires the trusted desktop host");
  }
  return invoke<InvestigationTeamQualificationDto>(
    "run_live_investigation_team_qualification",
  );
}

/** Cooperatively cancel the provider-backed check. */
export async function hostCancelLiveInvestigationTeamQualification(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("cancel_live_investigation_team_qualification");
}

export type InvestigationTeamKnownAnswerMetricsDto = {
  required_scenarios: number;
  executed_scenarios: number;
  passed_scenarios: number;
  failed_scenarios: number;
  cancelled_scenarios: number;
  blocked_scenarios: number;
  total_latency_ms: number;
  total_message_content_bytes: number;
  total_provider_content_bytes: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_tokens?: number | null;
  cached_tokens?: number | null;
  cost_microusd?: number | null;
};

export type InvestigationTeamKnownAnswerScenarioDto = {
  scenario_id: string;
  status: "executed" | "failed" | "blocked" | "cancelled" | "not_scheduled" | string;
  passed: boolean;
  failed_dimensions: string[];
  latency_ms: number;
  message_content_bytes: number;
  provider_content_bytes: number;
  reported_model_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_tokens?: number | null;
  cached_tokens?: number | null;
  cost_microusd?: number | null;
  failure_code?: string | null;
};

export type InvestigationTeamKnownAnswerDto = {
  status: "qualified" | "failed" | "partial" | "cancelled" | "blocked" | "stale" | string;
  reported_status: "qualified" | "failed" | "partial" | "cancelled" | "blocked" | string;
  stale: boolean;
  stale_reasons: string[];
  observed_at: number;
  role: string;
  build_identity: string;
  subject_storage_id: string;
  profile_id: string;
  model_id: string;
  endpoint_fingerprint: string;
  suite_id: string;
  suite_digest: string;
  prompt_set_hash: string;
  orchestration_policy_fingerprint: string;
  metrics: InvestigationTeamKnownAnswerMetricsDto;
  scenarios: InvestigationTeamKnownAnswerScenarioDto[];
  redacted_json: string;
  redacted_markdown: string;
};

/**
 * Read the redacted known-answer projection without contacting a provider.
 * The host store can also contain separately protected private canonical
 * responses, but they never cross this renderer API.
 */
export async function hostListInvestigationTeamKnownAnswerQualifications(): Promise<InvestigationTeamKnownAnswerDto[]> {
  if (!isTauri()) return [];
  return invoke<InvestigationTeamKnownAnswerDto[]>(
    "list_investigation_team_known_answer_qualifications",
  );
}

/**
 * Run all checked-in opaque known-answer scenarios for every configured V1
 * Investigation Team role. The trusted host owns the suite and evaluator truth.
 */
export async function hostRunLiveInvestigationTeamKnownAnswerQualification(): Promise<InvestigationTeamKnownAnswerDto[]> {
  if (!isTauri()) {
    throw new Error("Known-answer qualification requires the trusted desktop host");
  }
  return invoke<InvestigationTeamKnownAnswerDto[]>(
    "run_live_investigation_team_known_answer_qualification",
  );
}

/** Cooperatively cancel the current known-answer suite after its active call. */
export async function hostCancelLiveInvestigationTeamKnownAnswerQualification(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>(
    "cancel_live_investigation_team_known_answer_qualification",
  );
}

/** Clear both redacted known-answer history and its private canonical captures. */
export async function hostClearInvestigationTeamKnownAnswerQualifications(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("clear_investigation_team_known_answer_qualifications");
}

export async function hostGetDefaultChatModel(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("get_default_chat_model");
}

export async function hostSetDefaultChatModel(
  model: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("set_default_chat_model", { model });
}

export type SessionMetaDto = {
  id: string;
  title: string;
  archived: boolean;
  trashed?: boolean;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  trashed_at?: string | null;
  message_count: number;
  preview: string;
  /** Linked log analysis corpus (#480). */
  linked_corpus_id?: string | null;
};

export type SessionSearchHitDto = {
  meta: SessionMetaDto;
  score: number;
  snippet: string;
};

export async function hostListChatSessions(): Promise<SessionMetaDto[]> {
  if (!isTauri()) return [];
  return invoke<SessionMetaDto[]>("list_chat_sessions");
}

export async function hostLoadChatSession(
  id: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("load_chat_session", { id });
}

export async function hostSaveChatSession(
  session: ChatSessionDto,
  expectedUpdatedAt: string | null = null,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("save_chat_session", {
    session,
    expectedUpdatedAt,
  });
}

export async function hostRenameChatSession(
  id: string,
  title: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("rename_chat_session", { id, title });
}

/** Soft-delete: move chat to trash (recoverable). */
export async function hostTrashChatSession(
  id: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  const session = await invoke<ChatSessionDto>("trash_chat_session", { id });
  // Host also retires activity server-side. This does two more things a
  // server-side retirement alone cannot: (1) tell every mounted renderer —
  // in THIS webview and any other open Tauri window — to drop its own
  // cached record for this session, so a pane that isn't the one that
  // triggered trash (e.g. the chat archive list trashing a session shown in
  // a different window) cannot keep displaying it; (2) it is a no-op,
  // idempotent belt-and-suspenders call, safe even if the host-side
  // retirement already ran.
  const { forgetSessionActivity } = await import("./engine/turnActivity");
  await forgetSessionActivity(id);
  await publishTurnActivityUpdate({ sessionId: id, retired: true });
  return session;
}

/** Restore chat from trash. */
export async function hostRestoreChatSession(
  id: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("restore_chat_session", { id });
}

/** Permanently delete chat file. Prefer trash for user-facing delete. */
export async function hostDeleteChatSession(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_chat_session", { id });
  const { forgetSessionActivity } = await import("./engine/turnActivity");
  await forgetSessionActivity(id);
  await publishTurnActivityUpdate({ sessionId: id, retired: true });
}

/**
 * Stop live delivery of Developer detail for a session's in-flight turn.
 *
 * Called when the operator turns Developer detail off while a turn is still
 * streaming — the host-side latch is one-way, so this only ever stops
 * delivery early; it can never resurrect it for a turn already cut off.
 */
export async function hostSuppressDeveloperActivityDetail(
  sessionId: string,
): Promise<void> {
  if (!isTauri() || !sessionId) return;
  try {
    await invoke("suppress_developer_activity_detail", { sessionId });
  } catch {
    // Best-effort: worst case the in-flight turn keeps streaming detail
    // until it ends, same as before this fix.
  }
}

export async function hostPinChatSession(
  id: string,
  pinned: boolean,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("pin_chat_session", { id, pinned });
}

export async function hostArchiveChatSession(
  id: string,
  archived: boolean,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("archive_chat_session", { id, archived });
}

/** Keyword search over chat archive (title + body scoring). */
export async function hostSearchChatSessions(
  query: string,
  opts?: {
    limit?: number;
    includeArchived?: boolean;
    includeTrashed?: boolean;
    onlyTrashed?: boolean;
  },
): Promise<SessionSearchHitDto[]> {
  if (!isTauri()) return [];
  return invoke<SessionSearchHitDto[]>("search_chat_sessions", {
    query,
    limit: opts?.limit ?? 50,
    includeArchived: opts?.includeArchived ?? false,
    includeTrashed: opts?.includeTrashed ?? false,
    onlyTrashed: opts?.onlyTrashed ?? false,
  });
}

/** Brief title via active model (heuristic fallback if model down). */
export async function hostSuggestChatTitle(
  prompt: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string>("suggest_chat_title", { prompt });
}

/** LLM-retitle a saved session (no-op if user renamed / title_locked). */
export async function hostRetitleChatSession(
  id: string,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("retitle_chat_session", { id });
}

export type MemoryFileDto = {
  path: string;
  relative: string;
  title: string;
  body: string;
};

/** Durable store row (Phase 1 / #274). */
export type DurableMemoryDto = {
  id: string;
  kind: string;
  title: string;
  content: string;
  status: string;
  scope: string;
  updated_at: number;
  rev: number;
  source_id: string;
};

export async function hostListMemory(): Promise<MemoryFileDto[]> {
  if (!isTauri()) return [];
  // Prefer durable store listing when available.
  try {
    const durable = await invoke<DurableMemoryDto[]>("list_durable_memories", {
      kind: null,
      includeSuperseded: false,
      includeRetracted: false,
      limit: 200,
    });
    if (Array.isArray(durable)) {
      return durable.map((d) => ({
        path: d.source_id,
        relative: d.source_id,
        title: d.title || d.kind,
        body: d.content,
        // Extended fields carried via type assertion in shell mapping
        id: d.id,
        kind: d.kind,
        status: d.status,
        scope: d.scope,
      })) as MemoryFileDto[];
    }
  } catch {
    /* fall through to memory_fs */
  }
  return invoke<MemoryFileDto[]>("list_memory_notes");
}

export async function hostListDurableMemories(opts?: {
  kind?: string | null;
  includeSuperseded?: boolean;
  includeRetracted?: boolean;
  limit?: number;
}): Promise<DurableMemoryDto[]> {
  if (!isTauri()) return [];
  return invoke<DurableMemoryDto[]>("list_durable_memories", {
    kind: opts?.kind ?? null,
    includeSuperseded: opts?.includeSuperseded ?? false,
    includeRetracted: opts?.includeRetracted ?? false,
    limit: opts?.limit ?? 100,
  });
}

export async function hostGetDurableMemory(
  id: string,
): Promise<DurableMemoryDto | null> {
  if (!isTauri()) return null;
  return invoke<DurableMemoryDto | null>("get_durable_memory", { id });
}

/** User-initiated composition save (insert or supersede) after redaction (#293). */
export async function hostSaveCompositionDraft(args: {
  content: string;
  title: string;
  kind?: string;
  scope?: string;
  supersedeId?: string | null;
}): Promise<DurableMemoryDto> {
  if (!isTauri()) {
    throw new Error("Composition save requires Tauri host");
  }
  return invoke<DurableMemoryDto>("save_composition_draft", {
    content: args.content,
    title: args.title,
    kind: args.kind ?? null,
    scope: args.scope ?? null,
    supersede_id: args.supersedeId ?? null,
  });
}

/** Phase-2 capture proposal (not durable until Approve). */
export type MemoryCandidateDto = {
  id: string;
  kind: string;
  title: string;
  content: string;
  scope: string;
  salience: number;
  confidence: number;
  cue: string;
  sourceExcerpt: string;
  status: string;
  proposeSupersedeOf?: string | null;
  createdAt: number;
};

export async function hostListMemoryCandidates(opts?: {
  includeResolved?: boolean;
  limit?: number;
}): Promise<MemoryCandidateDto[]> {
  if (!isTauri()) return [];
  return invoke<MemoryCandidateDto[]>("list_memory_candidates", {
    includeResolved: opts?.includeResolved ?? false,
    limit: opts?.limit ?? 100,
  });
}

export async function hostApproveMemoryCandidate(
  id: string,
): Promise<DurableMemoryDto> {
  if (!isTauri()) throw new Error("Approve requires Tauri host");
  return invoke<DurableMemoryDto>("approve_memory_candidate", { id });
}

export async function hostDiscardMemoryCandidate(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("discard_memory_candidate", { id });
}

export async function hostEditMemoryCandidate(args: {
  id: string;
  title?: string;
  content?: string;
}): Promise<MemoryCandidateDto> {
  if (!isTauri()) throw new Error("Edit requires Tauri host");
  return invoke<MemoryCandidateDto>("edit_memory_candidate", {
    id: args.id,
    title: args.title ?? null,
    content: args.content ?? null,
  });
}

export async function hostBatchApproveMemoryCandidates(args?: {
  minConfidence?: number;
  minSalience?: number;
  typeConfirm?: string;
}): Promise<DurableMemoryDto[]> {
  if (!isTauri()) return [];
  return invoke<DurableMemoryDto[]>("batch_approve_memory_candidates", {
    minConfidence: args?.minConfidence ?? 0.55,
    minSalience: args?.minSalience ?? 0.4,
    typeConfirm: args?.typeConfirm ?? null,
  });
}

/** GDPR hard-delete + tombstone. typeConfirm must be exactly "PURGE". */
export async function hostPurgeMemoryGdpr(
  id: string,
  typeConfirm: string,
): Promise<{ id: string; purged_at: number; title_redacted: string }> {
  if (!isTauri()) throw new Error("Purge requires Tauri host");
  return invoke("purge_memory_gdpr", { id, typeConfirm });
}

export async function hostWriteMemory(
  filename: string,
  title: string,
  body: string,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Memory write requires Tauri host");
  }
  return invoke<string>("write_memory_note", { filename, title, body });
}

export type ConfluenceSettingsDto = {
  enabled: boolean;
  base_url: string;
  spaces: string[];
  pat_ref: string | null;
  write_enabled?: boolean;
  /** `bearer` | `basic` — serde rename_all snake_case from Rust. */
  auth_mode?: "bearer" | "basic";
  basic_email?: string | null;
};

export async function hostGetConfluence(): Promise<ConfluenceSettingsDto | null> {
  if (!isTauri()) return null;
  return invoke<ConfluenceSettingsDto>("get_confluence_settings");
}

export async function hostSaveConfluence(args: {
  enabled: boolean;
  baseUrl: string;
  spaces: string;
  pat?: string;
  writeEnabled?: boolean;
  /** Server/DC Bearer PAT vs Cloud Basic email+token. */
  authMode?: "bearer" | "basic";
  basicEmail?: string;
}): Promise<ConfluenceSettingsDto> {
  if (!isTauri()) {
    throw new Error("Confluence settings require Tauri host");
  }
  return invoke<ConfluenceSettingsDto>("save_confluence_settings", {
    req: {
      enabled: args.enabled,
      base_url: args.baseUrl,
      spaces: args.spaces,
      pat: args.pat ?? null,
      write_enabled: args.writeEnabled ?? false,
      auth_mode: args.authMode ?? "bearer",
      basic_email: args.basicEmail?.trim() || null,
    },
  });
}

export async function hostConfluenceHasToken(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("confluence_has_token");
}

export async function hostTestConfluence(): Promise<string> {
  if (!isTauri()) {
    throw new Error("Test requires Tauri host");
  }
  return invoke<string>("test_confluence_config");
}

export type ConfluenceSpaceDto = {
  key: string;
  name: string;
};

/** List remote spaces the PAT can see (does not change allowlist). */
export async function hostListConfluenceSpaces(
  limit?: number,
): Promise<ConfluenceSpaceDto[]> {
  if (!isTauri()) {
    throw new Error("Confluence space list requires Tauri host");
  }
  return invoke<ConfluenceSpaceDto[]>("list_confluence_spaces", {
    limit: limit ?? 50,
  });
}

export type XSettingsDto = {
  enabled: boolean;
  api_key_ref: string | null;
};

export async function hostGetX(): Promise<XSettingsDto | null> {
  if (!isTauri()) return null;
  return invoke<XSettingsDto>("get_x_settings");
}

export async function hostSaveX(args: {
  enabled: boolean;
  apiKey?: string;
}): Promise<XSettingsDto> {
  if (!isTauri()) {
    throw new Error("X settings require Tauri host");
  }
  return invoke<XSettingsDto>("save_x_settings", {
    req: {
      enabled: args.enabled,
      api_key: args.apiKey ?? null,
    },
  });
}

export async function hostXHasToken(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("x_has_token");
}

export async function hostTestX(): Promise<string> {
  if (!isTauri()) {
    throw new Error("Test requires Tauri host");
  }
  return invoke<string>("test_x_config");
}

export async function hostGetWebResearchEnabled(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("get_web_research_enabled");
}

export type RouterBudgetDto = {
  max_sources: number;
  max_tool_rounds: number;
  max_results_per_source: number;
  deadline_ms: number;
  deadline_is_explicit: boolean;
};

export async function hostGetRouterBudget(): Promise<RouterBudgetDto | null> {
  if (!isTauri()) return null;
  return invoke<RouterBudgetDto>("get_router_budget");
}

export async function hostSetRouterBudget(
  budget: RouterBudgetDto,
): Promise<RouterBudgetDto> {
  if (!isTauri()) {
    throw new Error("Router budget requires Tauri host");
  }
  return invoke<RouterBudgetDto>("set_router_budget", { req: budget });
}

/** Reasoning effort: omit = provider default (not a readiness badge). */
export type ReasoningEffortDto = {
  policy: string;
  level?: string | null;
};

export async function hostGetReasoningEffort(): Promise<ReasoningEffortDto | null> {
  if (!isTauri()) return null;
  return invoke<ReasoningEffortDto>("get_reasoning_effort");
}

export async function hostSetReasoningEffort(
  level: string | null,
): Promise<ReasoningEffortDto> {
  if (!isTauri()) {
    throw new Error("Reasoning effort settings require Tauri host");
  }
  return invoke<ReasoningEffortDto>("set_reasoning_effort", {
    req: { level },
  });
}

export async function hostSetWebResearchEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Web research settings require Tauri host");
  }
  return invoke<boolean>("set_web_research_enabled", { enabled });
}

/** Index lifecycle for UI (#117). Search works while phase is `indexing`. */
export type IndexStatusDto = {
  phase: "idle" | "indexing" | "ready" | "error";
  scanned: number;
  added: number;
  max_files: number;
  truncated: boolean;
  bytes_capped: boolean;
  resident_chunks: number;
  message: string;
};

export async function hostGetIndexStatus(): Promise<IndexStatusDto | null> {
  if (!isTauri()) return null;
  return invoke<IndexStatusDto>("get_index_status");
}

/** Hybrid search_kb opt-in (#119). Default off = keyword-only. */
export async function hostGetHybridRetrieval(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("get_hybrid_retrieval");
}

export async function hostSetHybridRetrieval(
  enabled: boolean,
): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Hybrid retrieval requires Tauri host");
  }
  return invoke<boolean>("set_hybrid_retrieval", { enabled });
}

/** Ambient durable-memory injection each turn (#271). Default ON. */
export async function hostGetAmbientRecallEnabled(): Promise<boolean | null> {
  if (!isTauri()) return null;
  return invoke<boolean>("get_ambient_recall_enabled");
}

// ── Log analysis (#362) — no secrets ──────────────────────────────────────

export type LogCorpusStatsDto = {
  files: number;
  discoveredFiles: number;
  excludedFiles: number;
  failedFiles: number;
  ignoredFiles: number;
  exclusionCounts: Record<string, number>;
  exclusionExamples: string[];
  partial: boolean;
  lines: number;
  templates: number;
  reductionRatio: number;
  embedded: number;
  sourceBytes: number;
  corpusBytes: number;
  levelCounts: Record<string, number>;
  tsMin: number | null;
  tsMax: number | null;
  formatCounts: Record<string, number>;
};

export type LogEmbeddingState =
  "keyword_only" | "deferred" | "partial" | "complete";

export type LogEmbeddingStatusDto = {
  state: LogEmbeddingState;
  modelId: string | null;
  embeddedTemplates: number;
  totalTemplates: number;
  reason: string | null;
  updatedAt: number;
  /**
   * Typed embedding-space identity the stored vectors were produced under.
   * Absent for a corpus written before typed binding existed, which is why
   * semantic retrieval fails closed for one until re-analysis rebinds it.
   */
  space?: EmbeddingSpaceIdentityDto | null;
};

/** Mirrors `cd_core::embedding_space::EmbeddingSpaceIdentity`. */
export type EmbeddingSpaceIdentityDto = {
  schema_id: string;
  /** SHA-256 of the normalized endpoint. Never the URL itself. */
  endpoint_fingerprint: string;
  model: string;
  dialect: string;
  representation: string;
  instruction?: string | null;
  preprocessing: string;
  chunking_version: string;
  dimensions?: number | null;
  synthetic: boolean;
};



export type LogTopTemplateDto = {
  id: number;
  pattern: string;
  count: number;
  severity: number;
};

export type IngestPipelineCompatibility =
  | "current"
  | "legacy_unknown"
  | "different_version";

export type LogCorpusSummaryDto = {
  id: string;
  name: string;
  eventCount: number;
  templateCount: number;
  engine: string;
  createdAt: number;
  sourceLabel: string | null;
  /** Semantic ingest-pipeline identity when known; null for legacy corpora. */
  ingestPipelineIdentity?: string | null;
  /**
   * Host-neutral compatibility vs this app build's pipeline.
   * Missing on older hosts — treat as legacy_unknown in UI.
   */
  ingestPipelineCompatibility?: IngestPipelineCompatibility | null;
  stats: LogCorpusStatsDto | null;
  topTemplates: LogTopTemplateDto[];
  embedding?: LogEmbeddingStatusDto | null;
};

export type LogFormatConfidenceOutcome = "matched" | "ambiguous" | "unknown";

export type LogTimeUnresolvedReason =
  "no_timezone" | "zone_abbreviation_not_resolved";

export type LogSourceConfidenceDto = {
  source: string;
  lines: number;
  formatId?: string | null;
  formatVersion?: number | null;
  outcome: LogFormatConfidenceOutcome;
  runnerUpMargin?: number | null;
  producerHint?: string | null;
  timeQuality: TimeQuality;
  unresolvedReasons?: LogTimeUnresolvedReason[];
  timestampPrefixSamples?: string[];
};

export type LogImportConfidenceCountsDto = {
  wall: number;
  orderOnly: number;
  mixed: number;
  matched: number;
  ambiguous: number;
  unknown: number;
  unresolved: number;
};

export type LogImportConfidenceDto = {
  corpusTimeQuality: TimeQuality;
  counts: LogImportConfidenceCountsDto;
  sources: LogSourceConfidenceDto[];
};

export type LogTimezoneDeclarationDto = {
  source: string;
  ianaZone: string;
  basis: "user_declared";
  declaredAt: number;
  appliedRevision: number;
};

export type LogTimezoneScopeDto = {
  corpusId: string;
  eventRevision: number;
};

export type LogTimezonePreviewRequestDto = {
  corpusId: string;
  eventRevision: number;
  source: string;
  ianaZone: string;
};

export type LogTimezoneResolutionPreviewDto = {
  corpusId: string;
  eventRevision: number;
  source: string;
  ianaZone: string;
  previewToken: string;
  affectedRecords: number;
  existingWallClockRecords: number;
  firstResolvedTs: number | null;
  lastResolvedTs: number | null;
  dstGapRecords: number;
  dstFoldAmbiguities: number;
  unchangedOrderOnlyRecords: number;
  unsupportedTimestampRecords: number;
  zoneAbbreviationMismatchRecords: number;
  outOfRangeRecords: number;
  precision: "whole_second";
};

export type LogTimezoneApplyRequestDto = {
  corpusId: string;
  expectedRevision: number;
  source: string;
  ianaZone: string;
  previewToken: string;
};

export type LogTimezoneClearRequestDto = {
  corpusId: string;
  expectedRevision: number;
  source: string;
  appliedRevision: number;
};

export type LogTimezoneSourceStatusDto = {
  source: string;
  unresolvedLocalRecords: number;
  resolvedLocalRecords: number;
  explicitWallClockRecords: number;
  otherOrderOnlyRecords: number;
};

export type LogTimezoneStateDto = {
  corpusId: string;
  eventRevision: number;
  declarations: Record<string, LogTimezoneDeclarationDto | undefined>;
  sources: LogTimezoneSourceStatusDto[];
};

export type LogEventRevisionReportDto = {
  revision: number;
  previousRevision: number;
  changedEvents: number;
  eventCount: number;
  tsMin: number | null;
  tsMax: number | null;
};

/** Separate ingest operation timings from core (#824). Not a universal SLA. */
export type LogIngestPhaseTimingsDto = {
  discoverReadMs: number;
  parseFrameMs: number;
  templateAnalysisMs: number;
  persistIndexMs: number;
  optionalEmbeddingMs: number;
  validationMs: number;
  publicationMs: number;
  totalMs: number;
  embeddingDeferred: boolean;
};

export type LogIngestReportDto = {
  corpusId: string;
  lines: number;
  templates: number;
  reductionRatio: number;
  embedded: number;
  files: number;
  discoveredFiles: number;
  excludedFiles: number;
  failedFiles: number;
  ignoredFiles: number;
  exclusionCounts: Record<string, number>;
  exclusionExamples: string[];
  partial: boolean;
  sourceBytes: number;
  corpusBytes: number;
  levelCounts: Record<string, number>;
  tsMin: number | null;
  tsMax: number | null;
  formatCounts: Record<string, number>;
  topTemplates: LogTopTemplateDto[];
  embedding?: LogEmbeddingStatusDto | null;
  confidence?: LogImportConfidenceDto | null;
  /** Completion/diagnostic phase breakdown (#824); optional for older hosts. */
  phaseTimings?: LogIngestPhaseTimingsDto | null;
  /** Classified complete/partial/rejected document from current hosts. */
  outcome?: {
    schemaId: string;
    schemaVersion: number;
    class: "complete" | "partial" | "rejected";
    published: boolean;
    corpusId?: string | null;
  } | null;
};

export type DemoLogInstallDto = {
  status:
    "installed" | "already_installed" | "cancelled" | "unavailable" | "failed";
  demoIdentity: string;
  corpusId: string | null;
  corpusName: string;
  events: number | null;
  detail: string;
  retryable: boolean;
};

export type FailedLogIngestDiagnosticDto = {
  schemaVersion: number;
  generatedAt: number;
  sourceKind: "directory" | "zip" | "file" | "unknown";
  reasonCode:
    | "cancelled"
    | "no_importable_files"
    | "no_safe_events"
    | "invalid_archive"
    | "policy_rejected"
    | "source_metadata_failed"
    | "source_open_failed"
    | "source_read_failed"
    | "source_changed"
    | "worker_failed"
    | "ingest_failed";
  summary: string;
  cancelled: boolean;
  progress: {
    lastPhase: string;
    linesProcessed: number | null;
    filesProcessed: number | null;
    bytesProcessed: number | null;
    templates: number | null;
    updatesSeen: number;
  };
  evidence: {
    scanCounts: {
      binary: number;
      empty: number;
      hidden: number;
      oversized: number;
      readFailed: number;
      parseFailed: number;
    };
    transcript: {
      reason:
        | "binary"
        | "empty"
        | "hidden"
        | "oversized"
        | "read_failed"
        | "parse_failed";
      basename: string;
    }[];
    omittedEntries: number;
  };
  redacted: true;
};

export type LogPackageImportDto = {
  corpusId: string;
  name: string;
  originCorpusId: string;
};

export type LogTemplateRowDto = {
  id: number;
  pattern: string;
  count: number;
  severity: number;
};

export type LogClusterDto = {
  clusterId: number;
  label: string;
  count: number;
  severity: number;
  score: number;
  templateIds: number[];
  exemplars: string[];
};

export type LogTimelineBucketDto = {
  start: number;
  width: number;
  count: number;
};

export type LogSearchHitDto = {
  templateId: number;
  pattern: string;
  score: number;
  semanticScore: number;
  count: number;
  severity: number;
  exemplars: string[];
};

export async function hostListLogCorpora(): Promise<
  LogCorpusSummaryDto[] | null
> {
  if (!isTauri()) return [];
  return invoke<LogCorpusSummaryDto[]>("list_log_corpora");
}

export async function hostIngestLogPath(
  path: string,
  name?: string,
  correlationId?: string,
): Promise<LogIngestReportDto> {
  if (!isTauri()) throw new Error("Log ingest requires Tauri host");
  return invoke<LogIngestReportDto>("ingest_log_path", {
    path,
    name: name ?? null,
    correlationId: correlationId ?? null,
  });
}

/** Explicit first-run install of the packaged synthetic 25k log corpus. */
export async function hostInstallDemoLogCorpus(): Promise<DemoLogInstallDto> {
  if (!isTauri()) {
    return {
      status: "unavailable",
      demoIdentity: "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1",
      corpusId: null,
      corpusName: "Demo · seven-day performance triage",
      events: null,
      detail: "Packaged demo logs require the installed desktop app.",
      retryable: false,
    };
  }
  return invoke<DemoLogInstallDto>("install_demo_log_corpus", undefined);
}

/** Request cancel of SoftWrite log ingest (#498). */
export async function hostCancelLogIngest(
  correlationId?: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("cancel_log_ingest", {
    correlationId: correlationId ?? null,
  });
}

/** One memory-only failed-ingest diagnostic for the latest failed trial. */
export async function hostGetFailedLogIngestDiagnostic(): Promise<FailedLogIngestDiagnosticDto | null> {
  if (!isTauri()) return null;
  return invoke<FailedLogIngestDiagnosticDto | null>(
    "get_failed_log_ingest_diagnostic",
  );
}

/** Clear the memory-only failed-ingest diagnostic. */
export async function hostClearFailedLogIngestDiagnostic(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("clear_failed_log_ingest_diagnostic");
}

/** Trusted local template-vector re-analysis; events are not reparsed. */
export async function hostReanalyzeLogCorpus(
  corpusId: string,
  correlationId?: string,
): Promise<LogEmbeddingStatusDto> {
  if (!isTauri()) throw new Error("Log re-analysis requires the desktop app");
  return invoke<LogEmbeddingStatusDto>("reanalyze_log_corpus", {
    corpusId,
    correlationId: correlationId ?? null,
  });
}

export async function hostCancelLogReanalysis(
  correlationId?: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("cancel_log_reanalysis", {
    correlationId: correlationId ?? null,
  });
}

/** Multi-phase process progress (#445 / #824) — redacted; no full home paths. */
export type ProcessProgressDto = {
  /** Host-generated id shared by every update from one command invocation. */
  operation_id?: string | null;
  /** Renderer correlation validated and echoed by the host. */
  correlation_id?: string | null;
  kind: "log_ingest" | "session_context_import";
  phase: string;
  message: string;
  fraction: number | null;
  lines_processed: number | null;
  files_processed: number | null;
  bytes_processed: number | null;
  templates: number | null;
  cancellable: boolean;
  /** Wall-clock ms since operation start (#824). */
  elapsed_ms?: number | null;
  /** Wall-clock ms of previous phase when transitioning (#824). */
  phase_elapsed_ms?: number | null;
};

export async function hostListenProcessProgress(
  onEvent: (p: ProcessProgressDto) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ProcessProgressDto>("process-progress", (event) => {
    onEvent(event.payload);
  });
}

export async function hostSessionContextImportPath(
  sessionId: string,
  path: string,
): Promise<unknown> {
  if (!isTauri()) throw new Error("Session context requires Tauri host");
  return invoke("session_context_import_path", { sessionId, path });
}

export async function hostLogClusterProblems(
  corpusId: string,
  maxClusters?: number,
): Promise<LogClusterDto[] | null> {
  if (!isTauri()) return [];
  return invoke<LogClusterDto[]>("log_cluster_problems", {
    corpusId,
    maxClusters: maxClusters ?? null,
  });
}

export async function hostLogTimeline(
  corpusId: string,
  widthSecs?: number,
): Promise<LogTimelineBucketDto[] | null> {
  if (!isTauri()) return [];
  return invoke<LogTimelineBucketDto[]>("log_timeline", {
    corpusId,
    widthSecs: widthSecs ?? null,
  });
}

export async function hostLogSearch(
  corpusId: string,
  query: string,
  k?: number,
): Promise<LogSearchHitDto[] | null> {
  if (!isTauri()) return [];
  return invoke<LogSearchHitDto[]>("log_search", {
    corpusId,
    query,
    k: k ?? null,
  });
}

export async function hostDiscardLogCorpus(corpusId: string): Promise<void> {
  if (!isTauri()) throw new Error("Discard requires Tauri host");
  await invoke("discard_log_corpus", { corpusId });
}

export async function hostLoadLogTimezoneState(
  corpusId: string,
): Promise<LogTimezoneStateDto> {
  if (!isTauri()) {
    return {
      corpusId,
      eventRevision: 0,
      declarations: {},
      sources: [],
    };
  }
  return invoke<LogTimezoneStateDto>("log_load_timezone_state", { corpusId });
}

export async function hostPreviewLogSourceTimezone(
  request: LogTimezonePreviewRequestDto,
): Promise<LogTimezoneResolutionPreviewDto> {
  if (!isTauri()) {
    throw new Error("Timezone review requires the desktop app");
  }
  return invoke<LogTimezoneResolutionPreviewDto>(
    "log_preview_source_timezone",
    request,
  );
}

export async function hostApplyLogSourceTimezone(
  request: LogTimezoneApplyRequestDto,
): Promise<LogEventRevisionReportDto> {
  if (!isTauri()) {
    throw new Error("Timezone review requires the desktop app");
  }
  return invoke<LogEventRevisionReportDto>(
    "log_apply_source_timezone",
    request,
  );
}

export async function hostClearLogSourceTimezone(
  request: LogTimezoneClearRequestDto,
): Promise<LogEventRevisionReportDto> {
  if (!isTauri()) {
    throw new Error("Timezone review requires the desktop app");
  }
  return invoke<LogEventRevisionReportDto>(
    "log_clear_source_timezone",
    request,
  );
}

export type OperationalMetricsAttachmentSourceDto =
  | { kind: "manual_load" }
  | {
      kind: "incident_evidence";
      bundle_id: string;
      component_id: string;
    };

export type OperationalMetricsAttachmentMetadataDto = {
  schemaVersion: number;
  attachmentId: string;
  corpusId: string;
  contentSha256: string;
  contentBytes: number;
  metricSchemaVersion: number;
  displayName: string;
  validatedAtUnixSecs: number;
  source: OperationalMetricsAttachmentSourceDto;
  timeQualityDeclarations: TimeQuality[];
};

export type OperationalMetricsAttachmentDto = {
  metadata: OperationalMetricsAttachmentMetadataDto;
  documentText: string;
};

/** Persist one bounded, validated metric document for the exact corpus. */
export async function hostSaveLogOperationalMetricsAttachment(
  corpusId: string,
  documentText: string,
  displayLabel: string,
  source: OperationalMetricsAttachmentSourceDto = { kind: "manual_load" },
): Promise<OperationalMetricsAttachmentDto> {
  if (!isTauri()) {
    throw new Error("Metric attachment requires the desktop app");
  }
  return invoke<OperationalMetricsAttachmentDto>(
    "log_save_operational_metrics_attachment",
    { corpusId, documentText, displayLabel, source },
  );
}

/** Restore and revalidate the exact corpus's stored metric attachment. */
export async function hostLoadLogOperationalMetricsAttachment(
  corpusId: string,
): Promise<OperationalMetricsAttachmentDto> {
  if (!isTauri()) {
    throw new Error("Metric attachment requires the desktop app");
  }
  return invoke<OperationalMetricsAttachmentDto>(
    "log_load_operational_metrics_attachment",
    { corpusId },
  );
}

/** Remove only the exact corpus's stored metric attachment. */
export async function hostRemoveLogOperationalMetricsAttachment(
  corpusId: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Metric attachment requires the desktop app");
  }
  await invoke<void>("log_remove_operational_metrics_attachment", {
    corpusId,
  });
}

/**
 * Set the host default log corpus so agent tools can omit `corpus=`
 * (log wizard handoff after SoftWrite ingest).
 */
export async function hostSetActiveLogCorpus(
  corpusId: string | null,
): Promise<string | null> {
  if (!isTauri()) return corpusId;
  return invoke<string | null>("set_active_log_corpus", {
    corpusId,
  });
}

/** Current host default log corpus id, if any. */
export async function hostGetActiveLogCorpus(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_active_log_corpus");
}

export type LogExplorerTurnContextDto = {
  corpus_id: string;
  brief: string;
  /** Explorer Suspend-all: tools must not apply durable exclusions (#817). */
  noise_lens_suspended?: boolean;
};

export async function hostGetLogCorpus(
  corpusId: string,
): Promise<LogCorpusSummaryDto | null> {
  if (!isTauri()) return null;
  return invoke<LogCorpusSummaryDto>("get_log_corpus", { corpusId });
}

export async function hostListLogTemplates(
  corpusId: string,
  limit?: number,
): Promise<LogTemplateRowDto[] | null> {
  if (!isTauri()) return [];
  return invoke<LogTemplateRowDto[]>("list_log_templates", {
    corpusId,
    limit: limit ?? null,
  });
}

/** Export full analysis package (.cdlog.zip) to a filesystem path. */
export async function hostExportLogCorpusPackage(
  corpusId: string,
  path: string,
): Promise<string> {
  if (!isTauri()) throw new Error("Export requires Tauri host");
  return invoke<string>("export_log_corpus_package", { corpusId, path });
}

export type LogDiagnosticSaveStatus =
  | {
      status: "saved" | "cancelled";
    }
  | {
      status: "saved_with_warning";
      warning: string;
    };

export type PreparedLogDiagnosticDto = {
  reportId: string;
  markdown: string;
  json: string;
};

/** Ask the trusted host to validate, scrub, render, and retain an exact preview. */
export async function hostPrepareLogDiagnosticReport(
  manifest: import("./logDiagnosticReport").LogDiagnosticManifest,
): Promise<PreparedLogDiagnosticDto> {
  if (!isTauri()) throw new Error("Diagnostic export requires Tauri host");
  return invoke<PreparedLogDiagnosticDto>("prepare_log_diagnostic_report", {
    request: { manifest },
  });
}

/** Release one superseded process-local diagnostic preview. */
export async function hostReleaseLogDiagnosticReport(
  reportId: string,
): Promise<boolean> {
  if (!isTauri()) throw new Error("Diagnostic export requires Tauri host");
  return invoke<boolean>("release_log_diagnostic_report", {
    request: { reportId },
  });
}

/** Ask the trusted host to select and atomically write one reviewed diagnostic. */
export async function hostSaveLogDiagnosticReport(
  reportId: string,
  format: "markdown" | "json",
): Promise<LogDiagnosticSaveStatus> {
  if (!isTauri()) throw new Error("Diagnostic export requires Tauri host");
  return invoke<LogDiagnosticSaveStatus>("save_log_diagnostic_report", {
    request: {
      reportId,
      format,
    },
  });
}

// ── Log Explorer (#480) ─────────────────────────────────────────────────────

export type TimeQuality = "wall" | "mixed" | "order_only";

export type ExplorerEventDto = {
  seq: number;
  ts: number;
  timeQuality: TimeQuality;
  /** Immutable parser evidence; legacy_unknown means an older corpus cannot prove the numeric ts. */
  timestampProvenance?:
    | "explicit_wall_clock"
    | "unresolved_local"
    | "order_only"
    | "legacy_unknown";
  /** Exact source-local timestamp retained while an offsetless event awaits a timezone. */
  unresolvedLocalTimestamp?: string | null;
  level: string;
  service: string | null;
  host: string | null;
  templateId: number;
  traceId: string | null;
  message: string;
  source: string;
};

export type EventOriginalRepresentationDto =
  | {
      state: "available";
      label: "Original (redacted)" | string;
      text: string;
      sourceByteCount: number;
      redactedCharCount: number;
      storedCharCount: number;
      truncated: boolean;
      encodingNormalized: boolean;
      redactionApplied: boolean;
    }
  | {
      state: "unavailable";
      reason: string;
    };

export type EventQueryDto = {
  timeFrom?: number | null;
  timeTo?: number | null;
  seqFrom?: number | null;
  seqTo?: number | null;
  levels?: string[];
  sources?: string[];
  services?: string[];
  hosts?: string[];
  templateId?: number | null;
  templateIds?: number[];
  /** Exact template ids hidden by the active, user-approved suppression lens. */
  excludedTemplateIds?: number[];
  traceId?: string | null;
  keyword?: string | null;
  /** Explicit reversible view scope; never inferred from timestamp magnitude. */
  wallTimeOnly?: boolean;
  afterSeq?: number | null;
  /** Composite keyset with afterSeq when sortByTime (wall-time page cursor). */
  afterTs?: number | null;
  beforeSeq?: number | null;
  beforeTs?: number | null;
  limit?: number;
  sortByTime?: boolean;
};

export type SuppressionRuleOrigin =
  "human" | "detector_proposal" | "model_proposal";
export type SuppressionRuleState = "enabled" | "disabled" | "removed";
export type SuppressionRuleMutation = "disable" | "reenable" | "remove";
export type SuppressionAuditAction =
  "previewed" | "activated" | "disabled" | "reenabled" | "removed";

export type SuppressionTemplatePredicateDto = {
  templateId: number;
  templateFingerprint: string;
};

export type SuppressionRepresentativeEventDto = {
  seq: number;
  source: string;
  timestamp: number;
  timeQuality: TimeQuality;
  level: string;
  redactedExcerpt: string;
};

export type SuppressionPreviewDto = {
  token: string;
  corpusId: string;
  eventRevision: number;
  ruleRevision: number;
  name: string;
  rationale: string;
  predicate: SuppressionTemplatePredicateDto;
  origin: SuppressionRuleOrigin;
  matchingEventCount: number;
  incrementalEventCount: number;
  corpusEventCount: number;
  levelCounts: { level: string; count: number }[];
  sourceCount: number;
  timeSpan: { from: number; to: number };
  representatives: SuppressionRepresentativeEventDto[];
  createdAt: number;
};

/** Trusted-core resolution of one durable rule against the open corpus (#819). */
export type SuppressionRuleResolutionKind =
  | "matches_current"
  | "stale_target_missing"
  | "stale_fingerprint_changed"
  | "invalid_predicate"
  | "conflicting_predicate"
  | "inactive";

export type SuppressionRuleResolutionDto = {
  kind: SuppressionRuleResolutionKind;
  /** Fail-closed: only `matches_current` can exclude events. */
  matchesNothing: boolean;
  explanation: string;
};

export type SuppressionRuleDto = {
  id: string;
  name: string;
  rationale: string;
  predicate: SuppressionTemplatePredicateDto;
  origin: SuppressionRuleOrigin;
  state: SuppressionRuleState;
  createdAt: number;
  updatedAt: number;
  /** Ephemeral host resolution; omitted from durable sidecar. */
  resolution?: SuppressionRuleResolutionDto | null;
};

export type SuppressionAuditEntryDto = {
  id: string;
  revision: number;
  action: SuppressionAuditAction;
  ruleId?: string | null;
  previewToken?: string | null;
  createdAt: number;
};

export type SuppressionDocumentDto = {
  schemaVersion: number;
  corpusId: string;
  revision: number;
  rules: SuppressionRuleDto[];
  previews: SuppressionPreviewDto[];
  audit: SuppressionAuditEntryDto[];
  /** Template-analysis revision used when host resolved every rule. */
  resolvedTemplateRevision?: number | null;
};

/** Whether the host could establish a trusted exclusion set (#819). */
export type SuppressionLensState = "resolved" | "unavailable";

/**
 * The exclusion set the host enforces, as the host reports it.
 *
 * `templateIds` is empty whenever `state` is `unavailable`, because a policy
 * that cannot be read must hide nothing rather than keep hiding stale ids.
 */
export type TrustedSuppressionLensDto = {
  corpusId: string;
  state: SuppressionLensState;
  /** Payload-free explanation; present only when unavailable. */
  reason?: string | null;
  templateIds: number[];
  policyRevision?: number | null;
  eventRevision: number;
  templateAnalysisRevision: number;
};

/** Active = enabled matches_current rules apply; Suspended = exclude nothing. */
export type InvestigationNoiseLens = "active" | "suspended";

export type SuppressionMutationResultDto = {
  revision: number;
  rule: SuppressionRuleDto;
};

export type NoiseCandidateShape =
  | "steady"
  | "bursty"
  | "insufficient_time";

export type NoiseCandidateReasonCode =
  | "high_frequency"
  | "high_corpus_share"
  | "multi_source_repetition"
  | "temporally_persistent"
  | "level_dominated_info"
  | "level_dominated_warn"
  | "repetitive_error_risky"
  | "steady_background"
  | "already_suppressed";

export type NoiseCandidateRepresentativeDto = {
  seq: number;
  source: string;
  timestamp: number;
  timeQuality: TimeQuality;
  level: string;
  redactedExcerpt: string;
};

export type NoiseCandidateDto = {
  templateId: number;
  templateFingerprint: string;
  pattern: string;
  score: number;
  eventCount: number;
  corpusShareBps: number;
  sourceCount: number;
  timeQuality: TimeQuality;
  wallTimeSpan: { from: number; to: number } | null;
  orderSpan: { from: number; to: number } | null;
  levelCounts: { level: string; count: number }[];
  otherLevelCount: number;
  levelCountsTruncated: boolean;
  errorOrFatalCount: number;
  warnCount: number;
  infoCount: number;
  reasonCodes: NoiseCandidateReasonCode[];
  explanation: string;
  alreadySuppressed: boolean;
  shareBasis: string;
  proposalKind: string;
  representatives: NoiseCandidateRepresentativeDto[];
  shape: NoiseCandidateShape;
};

export type NoiseCandidateReportDto = {
  corpusId: string;
  unsuppressedEventCount: number;
  corpusEventCount: number;
  suppressionRevision: number;
  eventRevision: number;
  templateAnalysisRevision: number;
  alreadySuppressedTemplateIds: number[];
  timeQuality: TimeQuality;
  rawTimeQuality: TimeQuality;
  candidates: NoiseCandidateDto[];
  templatesScanned: number;
  eligibleCandidateCount: number;
  truncated: boolean;
  candidateCapTruncated: boolean;
  templateScanTruncated: boolean;
  responseBytesTruncated: boolean;
  metadataMissingTemplateIds: number[];
  databaseQueryCount: number;
  disclaimer: string;
  cancelled: boolean;
};

export type EventPageDto = {
  events: ExplorerEventDto[];
  nextCursor: number | null;
  /** Pair with nextCursor for time-sorted Load more (newer). */
  nextTs?: number | null;
  /** Pair with beforeSeq for reverse Load more (older) (#538). */
  prevCursor?: number | null;
  prevTs?: number | null;
  totalMatched: number;
  timeQuality: TimeQuality;
};

/** Bounded evidence rows/cursors without an exact full-filter count. */
export type EventRowsPageDto = Omit<EventPageDto, "totalMatched">;

/** Exact cursor-independent count for one event filter. */
export type EventCountDto = {
  totalMatched: number;
};

export type TimelineSummaryBucketDto = {
  index: number;
  start: number;
  end: number;
  count: number;
  byLevel: Record<string, number>;
};

export type TimelineSummaryDto = {
  timeQuality: TimeQuality;
  spanFrom: number | null;
  spanTo: number | null;
  bucketWidth: number;
  bucketCount: number;
  totalMatched: number;
  /** Non-empty buckets only; empty slots are represented by absent indexes. */
  buckets: TimelineSummaryBucketDto[];
};

export type SharedTimelineSeverity =
  "error" | "warn" | "info" | "debug" | "other";

export type SharedTimelineAxisBucketDto = {
  index: number;
  start: number;
  end: number;
};

export type SharedTimelineSeveritySeriesDto = {
  severity: SharedTimelineSeverity;
  counts: number[];
};

export type SharedTimelineLaneSummaryDto = {
  laneIndex: number;
  sourceCount: number;
  timeQuality: TimeQuality;
  totalMatched: number;
  counts: number[];
};

export type SharedTimelineSummaryDto = {
  timeQuality: TimeQuality;
  spanFrom: number | null;
  spanTo: number | null;
  bucketWidth: number;
  bucketCount: number;
  totalMatched: number;
  /** Complete fixed-width axis, including empty slots. */
  buckets: SharedTimelineAxisBucketDto[];
  counts: number[];
  /** Exactly Error, Warn, Info, Debug, and Other. */
  severitySeries: SharedTimelineSeveritySeriesDto[];
  /** Requested source lanes projected onto the same axis. */
  lanes: SharedTimelineLaneSummaryDto[];
};

export type LogFacetsDto = {
  sources: Record<string, number>;
  levels: Record<string, number>;
  services: Record<string, number>;
  hosts: Record<string, number>;
  timeQuality: TimeQuality;
  wallEventCount?: number;
  orderOnlyEventCount?: number;
};

export type LogSourceCatalogEntryDto = {
  /** Exact corpus-relative path; duplicate basenames remain distinct. */
  source: string;
  eventCount: number;
};

export type LogSourceCatalogQueryDto = {
  /** Case-insensitive literal substring over the full relative path. */
  search?: string | null;
  /** Exclusive full-path keyset returned by the preceding page. */
  cursor?: string | null;
  /** Zero uses the core default; the core rejects values above its hard cap. */
  limit?: number;
};

export type LogSourceCatalogPageDto = {
  sources: LogSourceCatalogEntryDto[];
  nextCursor: string | null;
  totalMatched: number;
};

export type EventSearchHitDto = {
  event: ExplorerEventDto;
  score: number;
  matchKind: string;
  templateId: number | null;
  excerpt?: string | null;
};

export type EventSearchResultDto = {
  hits: EventSearchHitDto[];
  /** Composite cursor for the next chronological search-result page. */
  nextCursor?: number | null;
  nextTs?: number | null;
  /** Exact for SQL literal search; unavailable for bounded regex/semantic scans. */
  totalMatched?: number | null;
  partial: boolean;
  diagnostic?: string | null;
  /** Cooperative backend cancellation completed; no continuation remains. */
  cancelled?: boolean;
  scanned: number;
};

export type SearchMatchMode = "literal" | "regex";

let logSearchRequestCounter = 0;

export function createLogSearchRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  logSearchRequestCounter += 1;
  return `find-${Date.now()}-${logSearchRequestCounter}`;
}

export type LogBookmarkDto = {
  id: string;
  label: string;
  seqFrom: number;
  seqTo: number;
  tsFrom?: number | null;
  tsTo?: number | null;
  eventRefs?: LogBookmarkEventRefDto[];
  evidenceStatus?: LogBookmarkEvidenceStatus;
  color?: string | null;
  note?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type LogBookmarkEventRefDto = {
  corpusId: string;
  seq: number;
  source: string;
  timestampHint: number;
  timeQualityHint: TimeQuality;
};

export type LogBookmarkEvidenceStatus =
  "legacy_range" | "verified" | "missing" | "stale";

export type InvestigationEvidenceItemDto = {
  id: string;
  title: string;
  provenance: "human";
  corpusId: string;
  eventRefs: LogBookmarkEventRefDto[];
  createdAt: number;
  updatedAt: number;
};

export type InvestigationFindingKind =
  "observation" | "inference" | "hypothesis";

export type InvestigationFindingLifecycle = "accepted" | "resolved";

export type InvestigationViewFilterDto = {
  levels: string[];
  sources: string[];
  services: string[];
  hosts: string[];
  timeFrom: number | null;
  timeTo: number | null;
  seqFrom: number | null;
  seqTo: number | null;
  templateId: number | null;
  traceId: string | null;
  keyword: string | null;
};

export type InvestigationViewLaneDto = {
  id: string;
  label: string;
  sources: string[];
};

export type InvestigationViewFindDto = {
  query: string;
  matchMode: "literal" | "regex";
  caseSensitive: boolean;
  semantic: boolean;
};

export type InvestigationViewAnchorDto = {
  laneId: string;
  eventRef: LogBookmarkEventRefDto;
};

export type InvestigationViewRecipeDto = {
  filters: InvestigationViewFilterDto;
  lanes: InvestigationViewLaneDto[];
  visibleLaneCount: number;
  linkMode: "independent" | "follow_cursor" | "align_time";
  focusedLaneId: string | null;
  focusedEvent: LogBookmarkEventRefDto | null;
  selection: LogBookmarkEventRefDto[];
  highlights: LogBookmarkEventRefDto[];
  find: InvestigationViewFindDto | null;
  viewportAnchors: InvestigationViewAnchorDto[];
};

/** Durable host-authored suppression-policy binding on a finding (#819). */
export type InvestigationPolicyBindingDto = {
  suppressionPolicyRevision: number;
  resolvedTemplateRevision: number;
  effectivePolicySha256: string;
  noiseLens: InvestigationNoiseLens | null;
};

export type InvestigationPolicyBindingStatus =
  | "unbound_legacy"
  | "current"
  | "made_under_different_policy"
  | "made_under_different_lens"
  | "current_lens_unknown";

export type InvestigationPolicyBindingResolutionDto = {
  binding?: InvestigationPolicyBindingDto | null;
  currentSuppressionPolicyRevision: number;
  currentResolvedTemplateRevision: number;
  currentEffectivePolicySha256: string;
  currentNoiseLens?: InvestigationNoiseLens | null;
  status: InvestigationPolicyBindingStatus;
};

export type InvestigationFindingItemDto = {
  id: string;
  kind: InvestigationFindingKind;
  lifecycle: InvestigationFindingLifecycle;
  title: string;
  whyItMatters: string;
  evidenceIds: string[];
  viewRecipe?: InvestigationViewRecipeDto | null;
  /** Durable binding; absent on readable pre-#819 legacy findings. */
  policyBinding?: InvestigationPolicyBindingDto | null;
  provenance: "human";
  createdAt: number;
  updatedAt: number;
};

export type ResolvedInvestigationFindingDto = {
  item: InvestigationFindingItemDto;
  policyBinding: InvestigationPolicyBindingResolutionDto;
};

export type InvestigationNoteItemDto = {
  id: string;
  title: string;
  body: string;
  evidenceIds: string[];
  findingIds?: string[] | null;
  provenance: "human";
  createdAt: number;
  updatedAt: number;
};

/** Proposed finding status (#646). */
export type ProposedFindingStatusDto =
  | "proposed"
  | "accepted"
  | "dismissed"
  | "superseded";

export type ProposedFindingItemDto = {
  id: string;
  status: ProposedFindingStatusDto;
  kind: "observation" | "inference" | "hypothesis";
  title: string;
  whyItMatters: string;
  caveats?: string | null;
  evidence: Array<{
    eventRef: LogBookmarkEventRefDto;
    role: "supporting" | "contradicting";
  }>;
  viewRecipe?: InvestigationViewRecipeDto | null;
  corpusId: string;
  investigationId: string;
  policyBinding?: InvestigationPolicyBindingDto | null;
  templateRevision?: number | null;
  suppressionPolicyRevision?: number | null;
  rankInputs?: {
    supportingCount: number;
    contradictingCount: number;
    timeSpanSecs?: number | null;
    levelWeight?: number | null;
  } | null;
  provenance: {
    source: "model" | "detector" | "internal";
    provider?: string | null;
    modelId?: string | null;
    runId?: string | null;
    toolName: string;
    detectorId?: string | null;
  };
  idempotencyKey: string;
  acceptance?: { acceptedAt: number; edited: boolean } | null;
  dismissReason?: string | null;
  acceptedFindingId?: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Authorable report section kind (#532); other sections are derived-only. */
export type ReportSectionKindDto =
  | "executive_summary"
  | "unresolved_questions"
  | "next_actions";

/** Privacy-safe proposal provenance (shared by proposal families). */
export type ProposalProvenanceDto = {
  source: "model" | "detector" | "internal";
  provider?: string | null;
  modelId?: string | null;
  runId?: string | null;
  toolName: string;
  detectorId?: string | null;
};

/** Durable human-authored report section — at most one per kind (#532). */
export type InvestigationReportSectionItemDto = {
  id: string;
  kind: ReportSectionKindDto;
  body: string;
  evidenceIds?: string[];
  findingIds?: string[];
  noteIds?: string[];
  provenance: "human";
  acceptedFromProposalId?: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Durable proposed report section awaiting human review (#532). */
export type ProposedReportSectionItemDto = {
  id: string;
  status: ProposedFindingStatusDto;
  kind: ReportSectionKindDto;
  body: string;
  evidenceIds?: string[];
  findingIds?: string[];
  noteIds?: string[];
  corpusId: string;
  investigationId: string;
  provenance: ProposalProvenanceDto;
  idempotencyKey: string;
  acceptance?: { acceptedAt: number; edited: boolean } | null;
  dismissReason?: string | null;
  acceptedSectionId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type InvestigationDocumentDto = {
  schemaVersion: number;
  id: string;
  revision: number;
  title: string;
  status: "active" | "archived";
  corpusLinks: { corpusId: string }[];
  evidence: InvestigationEvidenceItemDto[];
  findings?: InvestigationFindingItemDto[];
  notes?: InvestigationNoteItemDto[];
  /** Agent/detector proposals awaiting review (#646). */
  proposedFindings?: ProposedFindingItemDto[];
  /** Durable authored report sections, at most one per kind (#532). */
  reportSections?: InvestigationReportSectionItemDto[];
  /** Agent/detector report-section proposals awaiting review (#532). */
  proposedReportSections?: ProposedReportSectionItemDto[];
  createdAt: number;
  updatedAt: number;
};

export type InvestigationEvidenceReferenceDto = {
  eventRef: LogBookmarkEventRefDto;
  status: "verified" | "missing" | "stale";
  event?: ExplorerEventDto | null;
};

export type ResolvedInvestigationEvidenceDto = {
  item: InvestigationEvidenceItemDto;
  references: InvestigationEvidenceReferenceDto[];
};

export type ResolvedInvestigationDocumentDto = {
  document: InvestigationDocumentDto;
  evidence: ResolvedInvestigationEvidenceDto[];
  /** Host-resolved findings with current-vs-durable policy comparison (#819). */
  findings?: ResolvedInvestigationFindingDto[];
};

export type InvestigationEvidencePreviewDto = {
  investigationId: string;
  revision: number;
  item: InvestigationEvidenceItemDto;
  references: InvestigationEvidenceReferenceDto[];
};

export type InvestigationFindingViewPreviewDto = {
  investigationId: string;
  revision: number;
  findingId: string;
  policyBinding: InvestigationPolicyBindingResolutionDto;
  recipe: InvestigationViewRecipeDto;
  missingCount: number;
  staleCount: number;
};

export async function hostLogQueryEvents(
  corpusId: string,
  query: EventQueryDto = {},
): Promise<EventPageDto> {
  if (!isTauri()) {
    return {
      events: [],
      nextCursor: null,
      totalMatched: 0,
      timeQuality: "order_only",
    };
  }
  return invoke<EventPageDto>("log_query_events", { corpusId, query });
}

/** Load bounded evidence rows without waiting for an exact filtered count. */
export async function hostLogQueryEventRows(
  corpusId: string,
  query: EventQueryDto = {},
): Promise<EventRowsPageDto> {
  if (!isTauri()) {
    return {
      events: [],
      nextCursor: null,
      timeQuality: "order_only",
    };
  }
  return invoke<EventRowsPageDto>("log_query_event_rows", { corpusId, query });
}

/** Load/cache the exact total independently of bounded row pagination. */
export async function hostLogCountEvents(
  corpusId: string,
  query: EventQueryDto = {},
): Promise<EventCountDto> {
  if (!isTauri()) {
    return { totalMatched: 0 };
  }
  return invoke<EventCountDto>("log_count_events", { corpusId, query });
}

/**
 * Fetch the separately stored authoritative redacted source for one event.
 * This is intentionally not part of ordinary event pages and must be called
 * only from an explicit inspector action.
 */
export async function hostLogQueryEventOriginal(
  corpusId: string,
  seq: number,
): Promise<EventOriginalRepresentationDto> {
  if (!isTauri()) {
    throw new Error("Original event representation requires the desktop app");
  }
  return invoke<EventOriginalRepresentationDto>("log_query_event_original", {
    corpusId,
    seq,
  });
}

/** Fixed-size, filter-aware overview used only when the Explorer navigator opens. */
export async function hostLogTimelineSummary(
  corpusId: string,
  filter: EventQueryDto = {},
  maxBuckets = 96,
): Promise<TimelineSummaryDto> {
  if (!isTauri()) {
    return {
      timeQuality: "order_only",
      spanFrom: null,
      spanTo: null,
      bucketWidth: 1,
      bucketCount: 0,
      totalMatched: 0,
      buckets: [],
    };
  }
  return invoke<TimelineSummaryDto>("log_timeline_summary", {
    corpusId,
    query: { filter, maxBuckets },
  });
}

/** One bounded timeline response whose global, severity, and lane tracks share an axis. */
export async function hostLogSharedTimelineSummary(
  corpusId: string,
  filter: EventQueryDto = {},
  lanes: { sources: string[]; allSources?: boolean }[] = [],
  maxBuckets = 96,
): Promise<SharedTimelineSummaryDto> {
  if (!isTauri()) {
    return {
      timeQuality: "order_only",
      spanFrom: null,
      spanTo: null,
      bucketWidth: 1,
      bucketCount: 0,
      totalMatched: 0,
      buckets: [],
      counts: [],
      severitySeries: [
        { severity: "error", counts: [] },
        { severity: "warn", counts: [] },
        { severity: "info", counts: [] },
        { severity: "debug", counts: [] },
        { severity: "other", counts: [] },
      ],
      lanes: lanes.map((lane, laneIndex) => ({
        laneIndex,
        sourceCount: new Set(lane.sources).size,
        timeQuality: "order_only",
        totalMatched: 0,
        counts: [],
      })),
    };
  }
  return invoke<SharedTimelineSummaryDto>("log_shared_timeline_summary", {
    corpusId,
    query: { filter, lanes, maxBuckets },
  });
}

/** How a stable target resolved under filters. */
export type TargetResolveStatus = "found" | "hidden_by_filter" | "missing";

export type EventNeighborhoodQueryDto = {
  targetSeq: number;
  before?: number;
  after?: number;
  filter?: EventQueryDto;
  sortByTime?: boolean;
};

export type EventNeighborhoodDto = {
  status: TargetResolveStatus;
  target?: ExplorerEventDto | null;
  events: ExplorerEventDto[];
  targetIndex?: number | null;
  nextCursor?: number | null;
  nextTs?: number | null;
  prevCursor?: number | null;
  prevTs?: number | null;
  totalMatched: number;
  corpusTotal: number;
  timeQuality: TimeQuality;
};

/**
 * Load a bounded neighborhood around a stable event identity.
 * Used by Find, bookmark reveal, and agent navigation — never scans from corpus start.
 */
export async function hostLogQueryEventNeighborhood(
  corpusId: string,
  query: EventNeighborhoodQueryDto,
): Promise<EventNeighborhoodDto> {
  if (!isTauri()) {
    return {
      status: "missing",
      events: [],
      totalMatched: 0,
      corpusTotal: 0,
      timeQuality: "order_only",
    };
  }
  return invoke<EventNeighborhoodDto>("log_query_event_neighborhood", {
    corpusId,
    query,
  });
}

export async function hostLogFacets(
  corpusId: string,
  query: EventQueryDto = {},
): Promise<LogFacetsDto> {
  if (!isTauri()) {
    return {
      sources: {},
      levels: {},
      services: {},
      hosts: {},
      timeQuality: "order_only",
    };
  }
  return invoke<LogFacetsDto>("log_facets", { corpusId, query });
}

/** Complete source inventory; deliberately separate from top-N filter facets. */
export async function hostLogSourceCatalog(
  corpusId: string,
  query: LogSourceCatalogQueryDto = {},
): Promise<LogSourceCatalogPageDto> {
  if (!isTauri()) {
    return {
      sources: [],
      nextCursor: null,
      totalMatched: 0,
    };
  }
  return invoke<LogSourceCatalogPageDto>("log_source_catalog", {
    corpusId,
    query,
  });
}

export async function hostLogSearchEvents(
  corpusId: string,
  opts: {
    requestId?: string;
    query?: string;
    semantic?: boolean;
    k?: number;
    filter?: EventQueryDto;
    matchMode?: SearchMatchMode;
    caseSensitive?: boolean;
  } = {},
): Promise<EventSearchHitDto[]> {
  const result = await hostLogSearchEventsAdvanced(corpusId, opts);
  return result.hits;
}

/** Advanced search with partial/capped diagnostics (#523). */
export async function hostLogSearchEventsAdvanced(
  corpusId: string,
  opts: {
    requestId?: string;
    query?: string;
    semantic?: boolean;
    k?: number;
    filter?: EventQueryDto;
    matchMode?: SearchMatchMode;
    caseSensitive?: boolean;
  } = {},
): Promise<EventSearchResultDto> {
  if (!isTauri()) {
    return { hits: [], partial: false, scanned: 0 };
  }
  return invoke<EventSearchResultDto>("log_search_events", {
    args: {
      corpusId,
      requestId: opts.requestId ?? createLogSearchRequestId(),
      query: opts.query ?? null,
      semantic: opts.semantic ?? true,
      k: opts.k ?? null,
      filter: opts.filter ?? null,
      matchMode: opts.matchMode ?? "literal",
      caseSensitive: opts.caseSensitive ?? false,
    },
  });
}

/** Signal one request-scoped Explorer Find cancellation. */
export async function hostCancelLogSearch(requestId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("cancel_log_search", { requestId });
}

/**
 * Authoritative, bounded, payload-free suppression evidence for a diagnostic
 * export (#819). Every field is derived by the trusted host from the corpus
 * that is actually open; the renderer must never author these values.
 */
export async function hostLogSuppressionDiagnosticSnapshot(
  corpusId: string,
): Promise<LogDiagnosticSuppressionPolicyInput | null> {
  if (!isTauri()) return null;
  return invoke<LogDiagnosticSuppressionPolicyInput>(
    "log_suppression_diagnostic_snapshot",
    { corpusId },
  );
}

/** Durable, corpus-scoped exact-template suppression policy. */
export async function hostLogLoadSuppression(
  corpusId: string,
): Promise<SuppressionDocumentDto> {
  if (!isTauri()) {
    return {
      schemaVersion: 1,
      corpusId,
      revision: 0,
      rules: [],
      previews: [],
      audit: [],
    };
  }
  return invoke<SuppressionDocumentDto>("log_load_suppression", { corpusId });
}

/**
 * The exact exclusion set the host will honour for this corpus (#819).
 *
 * The renderer is outside the trusted computing base, so this is disclosure,
 * not a capability: every query re-derives the trusted set host-side and
 * intersects whatever the renderer asked for. Sending these ids back can
 * therefore never hide more than the durable policy authorizes, and sending
 * fewer — Suspend all, temporary reveal — still hides less.
 */
export async function hostLogSuppressionLens(
  corpusId: string,
): Promise<TrustedSuppressionLensDto> {
  if (!isTauri()) {
    return {
      corpusId,
      state: "resolved",
      templateIds: [],
      eventRevision: 0,
      templateAnalysisRevision: 0,
    };
  }
  return invoke<TrustedSuppressionLensDto>("log_suppression_lens", { corpusId });
}

/** Read-only, bounded exact-template proposals for explicit human review. */
export async function hostLogProposeNoiseCandidates(
  corpusId: string,
  options: {
    maxCandidates?: number;
    maxRepresentatives?: number;
  } = {},
): Promise<NoiseCandidateReportDto> {
  if (!isTauri()) {
    return {
      corpusId,
      unsuppressedEventCount: 0,
      corpusEventCount: 0,
      suppressionRevision: 0,
      eventRevision: 0,
      templateAnalysisRevision: 0,
      alreadySuppressedTemplateIds: [],
      timeQuality: "order_only",
      rawTimeQuality: "order_only",
      candidates: [],
      templatesScanned: 0,
      eligibleCandidateCount: 0,
      truncated: false,
      candidateCapTruncated: false,
      templateScanTruncated: false,
      responseBytesTruncated: false,
      metadataMissingTemplateIds: [],
      databaseQueryCount: 0,
      disclaimer:
        "Noise candidates require the packaged desktop host. Nothing was auto-suppressed.",
      cancelled: false,
    };
  }
  return invoke<NoiseCandidateReportDto>("log_propose_noise_candidates", {
    args: {
      corpusId,
      maxCandidates: options.maxCandidates ?? null,
      maxRepresentatives: options.maxRepresentatives ?? null,
    },
  });
}

/** Compute and persist a trusted-core preview; the caller supplies no counts. */
export async function hostLogPreviewTemplateSuppression(
  corpusId: string,
  args: {
    expectedRevision: number;
    name: string;
    rationale: string;
    templateId: number;
  },
): Promise<SuppressionPreviewDto> {
  if (!isTauri()) throw new Error("Noise-rule preview requires Tauri host");
  return invoke<SuppressionPreviewDto>("log_preview_template_suppression", {
    args: {
      corpusId,
      expectedRevision: args.expectedRevision,
      name: args.name,
      rationale: args.rationale,
      templateId: args.templateId,
    },
  });
}

/** Activate one current human-authored preview token. */
export async function hostLogActivateTemplateSuppression(
  corpusId: string,
  expectedRevision: number,
  previewToken: string,
): Promise<SuppressionMutationResultDto> {
  if (!isTauri()) throw new Error("Noise-rule activation requires Tauri host");
  return invoke<SuppressionMutationResultDto>(
    "log_activate_template_suppression",
    {
      args: { corpusId, expectedRevision, previewToken },
    },
  );
}

/** Disable, re-enable, or tombstone one durable suppression rule. */
export async function hostLogMutateTemplateSuppressionRule(
  corpusId: string,
  expectedRevision: number,
  ruleId: string,
  mutation: SuppressionRuleMutation,
): Promise<SuppressionMutationResultDto> {
  if (!isTauri()) throw new Error("Noise-rule mutation requires Tauri host");
  return invoke<SuppressionMutationResultDto>(
    "log_mutate_template_suppression_rule",
    {
      args: { corpusId, expectedRevision, ruleId, mutation },
    },
  );
}

export async function hostLogListBookmarks(
  corpusId: string,
): Promise<LogBookmarkDto[]> {
  if (!isTauri()) return [];
  return invoke<LogBookmarkDto[]>("log_list_bookmarks", { corpusId });
}

export async function hostLogAddBookmark(
  corpusId: string,
  args: {
    seqFrom: number;
    seqTo: number;
    eventRefs?: LogBookmarkEventRefDto[];
    label: string;
    note?: string | null;
    color?: string | null;
    tsFrom?: number | null;
    tsTo?: number | null;
  },
): Promise<LogBookmarkDto> {
  if (!isTauri()) throw new Error("Bookmarks require Tauri host");
  return invoke<LogBookmarkDto>("log_add_bookmark", {
    args: {
      corpusId,
      seqFrom: args.seqFrom,
      seqTo: args.seqTo,
      eventRefs: args.eventRefs ?? [],
      label: args.label,
      note: args.note ?? null,
      color: args.color ?? null,
      tsFrom: args.tsFrom ?? null,
      tsTo: args.tsTo ?? null,
    },
  });
}

export async function hostLogDeleteBookmark(
  corpusId: string,
  bookmarkId: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("log_delete_bookmark", { corpusId, bookmarkId });
}

export async function hostLogLoadActiveInvestigation(
  corpusId: string,
  noiseLens: InvestigationNoiseLens = "active",
): Promise<ResolvedInvestigationDocumentDto | null> {
  if (!isTauri()) return null;
  return invoke<ResolvedInvestigationDocumentDto | null>(
    "log_load_active_investigation",
    { corpusId, noiseLens },
  );
}

export type PreparedInvestigationEvidenceTargetDto = {
  commitToken: string;
  investigationId: string | null;
  expectedRevision: number | null;
  createsDraft: boolean;
};

export async function hostLogPrepareInvestigationEvidence(
  corpusId: string,
  args: {
    title: string;
    eventRefs: LogBookmarkEventRefDto[];
    noiseLens?: InvestigationNoiseLens;
  },
): Promise<PreparedInvestigationEvidenceTargetDto> {
  if (!isTauri()) throw new Error("Investigation evidence requires Tauri host");
  return invoke<PreparedInvestigationEvidenceTargetDto>(
    "log_prepare_investigation_evidence",
    {
      args: {
        corpusId,
        title: args.title,
        eventRefs: args.eventRefs,
        noiseLens: args.noiseLens ?? "active",
      },
    },
  );
}

export async function hostLogCommitInvestigationEvidence(
  commitToken: string,
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) throw new Error("Investigation evidence requires Tauri host");
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_commit_investigation_evidence",
    { commitToken },
  );
}

export async function hostLogCancelInvestigationEvidencePrepare(
  commitToken: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("log_cancel_investigation_evidence_prepare", {
    commitToken,
  });
}

export async function hostLogAddInvestigationEvidence(
  corpusId: string,
  args: {
    investigationId?: string | null;
    expectedRevision?: number | null;
    title: string;
    eventRefs: LogBookmarkEventRefDto[];
    noiseLens?: InvestigationNoiseLens;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) throw new Error("Investigation evidence requires Tauri host");
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_add_investigation_evidence",
    {
      args: {
        corpusId,
        investigationId: args.investigationId ?? null,
        expectedRevision: args.expectedRevision ?? null,
        title: args.title,
        eventRefs: args.eventRefs,
        noiseLens: args.noiseLens ?? "active",
      },
    },
  );
}

export async function hostLogAddInvestigationFinding(
  corpusId: string,
  args: {
    investigationId?: string | null;
    expectedRevision?: number | null;
    kind: InvestigationFindingKind;
    title: string;
    whyItMatters: string;
    eventRefs: LogBookmarkEventRefDto[];
    viewRecipe?: InvestigationViewRecipeDto | null;
    noiseLens?: InvestigationNoiseLens;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) throw new Error("Investigation findings require Tauri host");
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_add_investigation_finding",
    {
      args: {
        corpusId,
        investigationId: args.investigationId ?? null,
        expectedRevision: args.expectedRevision ?? null,
        kind: args.kind,
        title: args.title,
        whyItMatters: args.whyItMatters,
        eventRefs: args.eventRefs,
        viewRecipe: args.viewRecipe ?? null,
        noiseLens: args.noiseLens ?? "active",
      },
    },
  );
}

export async function hostLogAddInvestigationNote(
  corpusId: string,
  args: {
    investigationId?: string | null;
    expectedRevision?: number | null;
    title: string;
    body: string;
    eventRefs: LogBookmarkEventRefDto[];
    findingIds?: string[];
    noiseLens?: InvestigationNoiseLens;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) throw new Error("Investigation notes require Tauri host");
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_add_investigation_note",
    {
      args: {
        corpusId,
        investigationId: args.investigationId ?? null,
        expectedRevision: args.expectedRevision ?? null,
        title: args.title,
        body: args.body,
        eventRefs: args.eventRefs,
        findingIds: args.findingIds ?? [],
        noiseLens: args.noiseLens ?? "active",
      },
    },
  );
}

export async function hostLogEditInvestigationFinding(
  corpusId: string,
  args: {
    investigationId: string;
    expectedRevision: number;
    findingId: string;
    kind: InvestigationFindingKind;
    lifecycle: InvestigationFindingLifecycle;
    title: string;
    whyItMatters: string;
    noiseLens?: InvestigationNoiseLens;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) throw new Error("Investigation findings require Tauri host");
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_edit_investigation_finding",
    {
      args: {
        corpusId,
        ...args,
        noiseLens: args.noiseLens ?? "active",
      },
    },
  );
}

export async function hostLogEditInvestigationNote(
  corpusId: string,
  args: {
    investigationId: string;
    expectedRevision: number;
    noteId: string;
    title: string;
    body: string;
    evidenceIds: string[];
    findingIds?: string[];
    noiseLens?: InvestigationNoiseLens;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) throw new Error("Investigation notes require Tauri host");
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_edit_investigation_note",
    {
      args: {
        corpusId,
        ...args,
        findingIds: args.findingIds ?? [],
        noiseLens: args.noiseLens ?? "active",
      },
    },
  );
}

export async function hostLogPreviewInvestigationEvidence(
  corpusId: string,
  investigationId: string,
  evidenceId: string,
): Promise<InvestigationEvidencePreviewDto> {
  if (!isTauri()) {
    throw new Error("Investigation evidence preview requires Tauri host");
  }
  return invoke<InvestigationEvidencePreviewDto>(
    "log_preview_investigation_evidence",
    { corpusId, investigationId, evidenceId },
  );
}

export async function hostLogPreviewInvestigationFindingView(
  corpusId: string,
  investigationId: string,
  findingId: string,
  noiseLens: InvestigationNoiseLens = "active",
): Promise<InvestigationFindingViewPreviewDto> {
  if (!isTauri()) {
    throw new Error("Investigation view preview requires Tauri host");
  }
  return invoke<InvestigationFindingViewPreviewDto>(
    "log_preview_investigation_finding_view",
    { corpusId, investigationId, findingId, noiseLens },
  );
}

/**
 * Explicitly recompute one saved finding view under the exact current policy
 * and lens (#819). Uses optimistic investigation revision.
 */
export async function hostLogRecomputeInvestigationFindingView(
  corpusId: string,
  args: {
    investigationId: string;
    expectedRevision: number;
    findingId: string;
    viewRecipe: InvestigationViewRecipeDto;
    noiseLens?: InvestigationNoiseLens;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) {
    throw new Error("Investigation recompute requires Tauri host");
  }
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_recompute_investigation_finding_view",
    {
      args: {
        corpusId,
        investigationId: args.investigationId,
        expectedRevision: args.expectedRevision,
        findingId: args.findingId,
        viewRecipe: args.viewRecipe,
        noiseLens: args.noiseLens ?? "active",
      },
    },
  );
}

/** Trusted-host Apply gate (#656). Fails closed when exact refs are missing/stale. */
export async function hostLogApplyInvestigationFindingView(
  corpusId: string,
  investigationId: string,
  findingId: string,
  noiseLens: InvestigationNoiseLens = "active",
): Promise<InvestigationFindingViewPreviewDto> {
  if (!isTauri()) {
    throw new Error("Investigation view apply requires Tauri host");
  }
  return invoke<InvestigationFindingViewPreviewDto>(
    "log_apply_investigation_finding_view",
    { corpusId, investigationId, findingId, noiseLens },
  );
}

/** Human Accept / Edit-and-accept (#646). */
export async function hostLogAcceptProposedFinding(
  corpusId: string,
  investigationId: string,
  input: {
    proposalId: string;
    expectedRevision: number;
    edited?: boolean;
    kind?: "observation" | "inference" | "hypothesis";
    title?: string;
    whyItMatters?: string;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) {
    throw new Error("Accept proposed finding requires Tauri host");
  }
  return invoke<ResolvedInvestigationDocumentDto>("log_accept_proposed_finding", {
    corpusId,
    investigationId,
    input,
  });
}

/** Human Dismiss-with-reason (#646). */
export async function hostLogDismissProposedFinding(
  corpusId: string,
  investigationId: string,
  input: { proposalId: string; expectedRevision: number; reason: string },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) {
    throw new Error("Dismiss proposed finding requires Tauri host");
  }
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_dismiss_proposed_finding",
    { corpusId, investigationId, input },
  );
}

// ── Investigation report projection + export (#532) ─────────────────────────

/** Current-policy identity the host captured at assembly time (#532). */
export type InvestigationReportCurrentPolicyDto = {
  suppressionPolicyRevision: number;
  resolvedTemplateRevision: number;
  effectivePolicySha256: string;
  noiseLens: InvestigationNoiseLens;
};

/** Honest evidence time window derived only from durable exact refs. */
export type InvestigationReportTimeWindowDto = {
  minTimestampHint: number;
  maxTimestampHint: number;
  mixedQuality: boolean;
};

export type InvestigationReportScopeDto = {
  corpusIds: string[];
  evidenceCount: number;
  findingCount: number;
  noteCount: number;
  timeWindow?: InvestigationReportTimeWindowDto | null;
};

/** One authored section carried into the projection. */
export type InvestigationReportAuthoredSectionDto = {
  sectionId: string;
  body: string;
  evidenceIds: string[];
  findingIds: string[];
  noteIds: string[];
  acceptedFromProposalId?: string | null;
  acceptedProposalProvenance?: ProposalProvenanceDto | null;
  acceptedProposalAcceptance?: {
    acceptedAt: number;
    edited: boolean;
  } | null;
  updatedAt: number;
};

/** Authored sections in fixed order; absent slots render "Not authored". */
export type InvestigationReportSectionsDto = {
  executiveSummary?: InvestigationReportAuthoredSectionDto | null;
  unresolvedQuestions?: InvestigationReportAuthoredSectionDto | null;
  nextActions?: InvestigationReportAuthoredSectionDto | null;
};

/** One exact event identity plus its current resolution status. */
export type InvestigationReportEventReferenceDto = {
  corpusId: string;
  seq: number;
  source: string;
  timestampHint: number;
  timeQualityHint: TimeQuality;
  status: "verified" | "missing" | "stale";
};

export type InvestigationReportFindingCitationDto = {
  evidenceId: string;
  evidenceTitle: string;
  references: InvestigationReportEventReferenceDto[];
};

export type InvestigationReportFindingEntryDto = {
  findingId: string;
  kind: InvestigationFindingKind;
  lifecycle: InvestigationFindingLifecycle;
  title: string;
  whyItMatters: string;
  policyBindingStatus: InvestigationPolicyBindingStatus;
  hasSavedView: boolean;
  citations: InvestigationReportFindingCitationDto[];
  createdAt: number;
};

export type InvestigationReportTimelineEntryDto = {
  corpusId: string;
  seq: number;
  source: string;
  timestampHint: number;
  timeQualityHint: TimeQuality;
  evidenceId: string;
  evidenceTitle: string;
  status: "verified" | "missing" | "stale";
};

/** Bounded evidence-backed timeline with an explicit omitted count. */
export type InvestigationReportTimelineDto = {
  entries: InvestigationReportTimelineEntryDto[];
  omittedCount: number;
};

/**
 * Versioned, payload-free report projection (#532). Proposals never appear in
 * this projection; only accepted state is reported.
 */
export type InvestigationReportDto = {
  schemaVersion: number;
  investigationId: string;
  title: string;
  status: "active" | "archived";
  sourceRevision: number;
  generatedAt: number;
  currentPolicy?: InvestigationReportCurrentPolicyDto | null;
  scope: InvestigationReportScopeDto;
  sections: InvestigationReportSectionsDto;
  findings: InvestigationReportFindingEntryDto[];
  timeline: InvestigationReportTimelineDto;
};

/**
 * Host-assembled report preview: typed projection + rendered markdown + the
 * retained export artifact for exactly these bytes. One assembly drives the
 * surface, the exact markdown preview, and Export — `exportId` names the
 * host-retained copy of `markdown`; when the render cannot pass the export
 * boundary, `exportUnavailableReason` says why Export is off while the
 * preview still shows.
 */
export type LogInvestigationReportPreviewDto = {
  report: InvestigationReportDto;
  markdown: string;
  exportId: string | null;
  exportBytes: number | null;
  exportUnavailableReason: string | null;
};

/**
 * Assemble + render the report for the active (or given) Investigation.
 * Strictly non-mutating: preview only, current Explorer unchanged.
 */
export async function hostLogAssembleInvestigationReport(
  corpusId: string,
  investigationId?: string | null,
  noiseLens: InvestigationNoiseLens = "active",
): Promise<LogInvestigationReportPreviewDto> {
  if (!isTauri()) {
    throw new Error("Investigation reports require Tauri host");
  }
  return invoke<LogInvestigationReportPreviewDto>(
    "log_assemble_investigation_report",
    { corpusId, investigationId: investigationId ?? null, noiseLens },
  );
}

/** Create or replace the authored report section for one kind (#532). */
export async function hostLogSetInvestigationReportSection(
  corpusId: string,
  investigationId: string,
  expectedRevision: number,
  input: {
    kind: ReportSectionKindDto;
    body: string;
    evidenceIds?: string[];
    findingIds?: string[];
    noteIds?: string[];
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) {
    throw new Error("Investigation report sections require Tauri host");
  }
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_set_investigation_report_section",
    {
      corpusId,
      investigationId,
      expectedRevision,
      input: {
        kind: input.kind,
        body: input.body,
        evidenceIds: input.evidenceIds ?? [],
        findingIds: input.findingIds ?? [],
        noteIds: input.noteIds ?? [],
      },
    },
  );
}

/** Human Accept or Edit-and-accept of a Proposed report section (#532). */
export async function hostLogAcceptProposedReportSection(
  corpusId: string,
  investigationId: string,
  input: {
    proposalId: string;
    expectedRevision: number;
    /**
     * Replacement body for Edit-and-accept. Whether the acceptance counts as
     * an edit is host-derived from the durable body actually differing — the
     * renderer makes no claim.
     */
    body?: string | null;
  },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) {
    throw new Error("Accept proposed report section requires Tauri host");
  }
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_accept_proposed_report_section",
    { corpusId, investigationId, input },
  );
}

/** Human Dismiss-with-reason of a Proposed report section (#532). */
export async function hostLogDismissProposedReportSection(
  corpusId: string,
  investigationId: string,
  input: { proposalId: string; expectedRevision: number; reason: string },
): Promise<ResolvedInvestigationDocumentDto> {
  if (!isTauri()) {
    throw new Error("Dismiss proposed report section requires Tauri host");
  }
  return invoke<ResolvedInvestigationDocumentDto>(
    "log_dismiss_proposed_report_section",
    { corpusId, investigationId, input },
  );
}

/**
 * Ask the trusted host to select a destination (native Save panel) and
 * atomically write the exact previewed bytes. No renderer path authority.
 */
export async function hostLogSaveInvestigationReportExport(
  reportId: string,
): Promise<LogDiagnosticSaveStatus> {
  if (!isTauri()) {
    throw new Error("Investigation report export requires Tauri host");
  }
  return invoke<LogDiagnosticSaveStatus>(
    "log_save_investigation_report_export",
    { request: { reportId } },
  );
}

/** Release one superseded process-local report export preview. */
export async function hostLogReleaseInvestigationReportExport(
  reportId: string,
): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Investigation report export requires Tauri host");
  }
  return invoke<boolean>("log_release_investigation_report_export", {
    request: { reportId },
  });
}

export async function hostListChatSessionsForCorpus(
  corpusId: string,
): Promise<SessionMetaDto[]> {
  if (!isTauri()) return [];
  return invoke<SessionMetaDto[]>("list_chat_sessions_for_corpus", {
    corpusId,
  });
}

export async function hostSetChatLinkedCorpus(
  sessionId: string,
  corpusId: string | null,
  draftSession?: ChatSessionDto | null,
  expectedUpdatedAt?: string | null,
): Promise<ChatSessionDto | null> {
  if (!isTauri()) return null;
  return invoke<ChatSessionDto>("set_chat_linked_corpus", {
    sessionId,
    corpusId,
    draftSession: draftSession ?? null,
    expectedUpdatedAt: expectedUpdatedAt ?? null,
  });
}

/** Open multi-window Log Explorer for a corpus. */
export async function hostOpenLogExplorer(corpusId: string): Promise<string> {
  if (!isTauri()) throw new Error("Log Explorer requires Tauri host");
  return invoke<string>("open_log_explorer", { corpusId });
}

/** Exact-nav target kind for host-governed Explorer reveal (#698). */
export type LogExplorerNavTargetKind = "event" | "template";

/** One-shot exact navigation target (string ids only — never JS Number widen). */
export type LogExplorerNavTargetDto = {
  kind: LogExplorerNavTargetKind;
  /** Canonical decimal u64 string. */
  id: string;
};

export type OpenLogExplorerTargetResultDto = {
  windowLabel: string;
  corpusId: string;
  target: LogExplorerNavTargetDto;
};

/**
 * Host-governed exact navigation: validate corpus + target, open/focus that
 * corpus's Explorer, stage a one-shot deliver-once target.
 */
export async function hostOpenLogExplorerTarget(
  corpusId: string,
  target: LogExplorerNavTargetDto,
): Promise<OpenLogExplorerTargetResultDto> {
  if (!isTauri()) {
    throw new Error("Exact log navigation requires Tauri host");
  }
  return invoke<OpenLogExplorerTargetResultDto>("open_log_explorer_target", {
    corpusId,
    target,
  });
}

/**
 * Take (and clear) the pending exact-nav target for this corpus. Returns null
 * when nothing is pending — never replays a prior delivery.
 */
export async function hostTakeLogExplorerNavTarget(
  corpusId: string,
): Promise<LogExplorerNavTargetDto | null> {
  if (!isTauri()) return null;
  return invoke<LogExplorerNavTargetDto | null>("take_log_explorer_nav_target", {
    corpusId,
  });
}

/** Import portable package (SoftWrite — new disposable corpus). */
export async function hostImportLogCorpusPackagePath(
  path: string,
): Promise<LogPackageImportDto> {
  if (!isTauri()) throw new Error("Import package requires Tauri host");
  return invoke<LogPackageImportDto>("import_log_corpus_package_path", {
    path,
  });
}

export async function hostSetAmbientRecallEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Ambient recall settings require Tauri host");
  }
  return invoke<boolean>("set_ambient_recall_enabled", { enabled });
}

/** External module DTO (#136). No secrets. */
export type ModuleDto = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  granted: boolean;
  path: string;
  entrypoint: string;
  requested_filesystem_roots: string[];
  requested_network_hosts: string[];
  requested_secret_refs: string[];
  hard_write_tools: string[];
  provided_tools: string[];
};

export type SetModuleEnabledResult = {
  enabled: boolean;
  needs_approval: boolean;
  module_id: string;
  risk: string;
  type_confirm_phrase: string | null;
  preview: string;
  reason: string;
  request_id: string;
};

export async function hostListModules(): Promise<ModuleDto[]> {
  if (!isTauri()) return [];
  return invoke<ModuleDto[]>("list_modules");
}

/** Local path install only (NON_GOALS #7). */
export async function hostInstallModule(path: string): Promise<ModuleDto> {
  if (!isTauri()) throw new Error("Module install requires Tauri host");
  return invoke<ModuleDto>("install_module", { path });
}

export async function hostSetModuleEnabled(
  id: string,
  enabled: boolean,
): Promise<SetModuleEnabledResult> {
  if (!isTauri()) throw new Error("Module enable requires Tauri host");
  return invoke<SetModuleEnabledResult>("set_module_enabled", { id, enabled });
}

export async function hostApproveModuleEnable(
  id: string,
  decision: string,
  typed?: string,
): Promise<boolean> {
  if (!isTauri()) throw new Error("Module approve requires Tauri host");
  return invoke<boolean>("approve_module_enable", { id, decision, typed });
}

export async function hostRemoveModule(id: string): Promise<boolean> {
  if (!isTauri()) throw new Error("Module remove requires Tauri host");
  return invoke<boolean>("remove_module", { id });
}

/** Browse-only registry settings (#139). Default: disabled + empty URL. */
export type ModuleRegistrySettingsDto = {
  enabled: boolean;
  url: string;
};

export type ModuleRegistryEntryDto = {
  id: string;
  name: string;
  version: string;
  description: string;
  homepage: string | null;
  local_path: string | null;
  can_install_local: boolean;
};

export async function hostGetModuleRegistrySettings(): Promise<ModuleRegistrySettingsDto> {
  if (!isTauri()) return { enabled: false, url: "" };
  return invoke<ModuleRegistrySettingsDto>("get_module_registry_settings");
}

export async function hostSetModuleRegistrySettings(
  enabled: boolean,
  url: string,
): Promise<ModuleRegistrySettingsDto> {
  if (!isTauri()) throw new Error("Registry settings require Tauri host");
  return invoke<ModuleRegistrySettingsDto>("set_module_registry_settings", {
    enabled,
    url,
  });
}

/**
 * Browse registry metadata only — never auto-installs (NON_GOALS #7).
 * Pass `filePath` for offline local JSON; otherwise uses configured URL when enabled.
 */
export async function hostBrowseModuleRegistry(
  filePath?: string,
): Promise<ModuleRegistryEntryDto[]> {
  if (!isTauri()) return [];
  return invoke<ModuleRegistryEntryDto[]>("browse_module_registry", {
    filePath: filePath ?? null,
  });
}

export async function hostUpdateModule(
  id: string,
  path: string,
): Promise<ModuleDto> {
  if (!isTauri()) throw new Error("Module update requires Tauri host");
  return invoke<ModuleDto>("update_module", { id, path });
}

export type NewsSourceDto = {
  id: string;
  label: string;
  group: string;
  group_label: string;
  enabled: boolean;
  default_enabled: boolean;
  hint: string;
  feed_url: string;
};

export async function hostListWebResearchSources(): Promise<NewsSourceDto[]> {
  if (!isTauri()) return [];
  return invoke<NewsSourceDto[]>("list_web_research_sources");
}

export async function hostSetWebResearchSources(
  sources: Record<string, boolean>,
): Promise<NewsSourceDto[]> {
  if (!isTauri()) {
    throw new Error("Web research sources require Tauri host");
  }
  return invoke<NewsSourceDto[]>("set_web_research_sources", { sources });
}

export function setupToWorkspaceRoots(setup: AppSetupState): string[] {
  return setup.workspaceRoots;
}

/** Update check result for Settings (#173). No install until user confirms. */
export type UpdateCheckDto = {
  available: boolean;
  currentVersion: string;
  version?: string;
  body?: string | null;
  date?: string | null;
};

/**
 * Opt-in signed updater check (#173). Uses tauri-plugin-updater; never installs.
 * Returns `available: false` when not in Tauri or no update / network failure.
 */
export async function hostCheckForUpdates(): Promise<UpdateCheckDto> {
  if (!isTauri()) {
    return { available: false, currentVersion: "browser" };
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const { getVersion } = await import("@tauri-apps/api/app");
  const currentVersion = await getVersion();
  const update = await check();
  if (!update) {
    return { available: false, currentVersion };
  }
  return {
    available: true,
    currentVersion,
    version: update.version,
    body: update.body,
    date: update.date,
  };
}

/**
 * Download + install after explicit UI confirm (#173). Re-checks so install is
 * never silent; user confirmation is required by the caller first.
 */
export async function hostInstallUpdate(): Promise<void> {
  if (!isTauri()) {
    throw new Error("Updates require the desktop app");
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) {
    throw new Error("No update available");
  }
  await update.downloadAndInstall();
}

// ─── Logging Quality Assessment (deterministic; no provider) ─────────────────

export type {
  LoggingQualityAssessment,
  LoggingQualityAssessmentHostDto,
  LoggingQualityExportStatus,
  LoggingQualityFinding,
  LoggingQualityRunPhase,
} from "./loggingQuality/types";

/** Run pure host assessor for one imported corpus. */
export async function hostAssessLoggingQuality(
  corpusId: string,
): Promise<import("./loggingQuality/types").LoggingQualityAssessmentHostDto> {
  if (!isTauri()) {
    throw new Error("Logging quality assessment requires the desktop host");
  }
  const id = corpusId.trim();
  if (!id) {
    throw new Error("No corpus selected. Import or open a log corpus first.");
  }
  return invoke<import("./loggingQuality/types").LoggingQualityAssessmentHostDto>(
    "log_assess_logging_quality",
    { corpusId: id },
  );
}

/**
 * Host-owned Save panel + atomic no-clobber export.
 * Destination path never returns to the renderer.
 */
export async function hostExportLoggingQualityAssessment(
  corpusId: string,
  format: "json" | "markdown",
): Promise<import("./loggingQuality/types").LoggingQualityExportStatus> {
  if (!isTauri()) {
    throw new Error("Logging quality export requires the desktop host");
  }
  const id = corpusId.trim();
  if (!id) {
    throw new Error("No corpus selected. Import or open a log corpus first.");
  }
  return invoke<import("./loggingQuality/types").LoggingQualityExportStatus>(
    "log_export_logging_quality_assessment",
    {
      request: { corpusId: id, format },
    },
  );
}
