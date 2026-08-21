/**
 * Pure state for the unified import flow.
 *
 * Everything decidable without the engine lives here as plain functions over
 * immutable state: stage transitions, the selection model, tri-state
 * container derivation, leaf-only range selection, flow-through collapse,
 * and the zero-importable guard. The reducer is the single source of truth
 * the components render; trusted enforcement stays in core — these guards
 * are the courtesy layer that explains itself inline.
 */
import type { WireImportPreviewItem, WireImportPreviewPlan, WireImportPreviewReport } from "@contextdesk/contracts";
import type { ImportOutcomeClass, ImportRunReport } from "@contextdesk/client";
import type { WireProcessProgress } from "@contextdesk/contracts";

/** Flow stages. Post-publication review is part of `summary`, never a gate. */
export type ImportFlowStage =
  | "choose"
  | "previewing"
  | "preflight"
  | "selector"
  | "running"
  | "summary"
  | "preview_failed"
  | "run_failed"
  | "run_cancelled";

export type ImportFlowState = {
  stage: ImportFlowStage;
  path: string | null;
  corpusName: string;
  /** The reviewed plan binding a run to its exact inventory. */
  plan: WireImportPreviewPlan | null;
  report: WireImportPreviewReport | null;
  /** Identities currently selected for import (leaf identities only). */
  selected: ReadonlySet<string>;
  /** Anchor for shift-range selection, a leaf identity. */
  rangeAnchor: string | null;
  /**
   * The user asked to leave while a run was live. The flow stays visible,
   * requests cancellation, and only exits after the engine acknowledges
   * cancellation, failure, or publication.
   */
  exitRequested: boolean;
  error: string | null;
  /** Classified outcome attached to a failed run; absent on plain host strings. */
  errorOutcome: ImportRunReport["outcome"];
  progress: WireProcessProgress | null;
  runReport: ImportRunReport | null;
};

export const INITIAL_IMPORT_FLOW_STATE: ImportFlowState = {
  stage: "choose",
  path: null,
  corpusName: "incident",
  plan: null,
  report: null,
  selected: new Set(),
  rangeAnchor: null,
  exitRequested: false,
  error: null,
  errorOutcome: undefined,
  progress: null,
  runReport: null,
};

export type ImportFlowEvent =
  | { type: "PATH_CHOSEN"; path: string }
  | { type: "PREVIEW_OK"; plan: WireImportPreviewPlan }
  | { type: "PREVIEW_FAILED"; message: string }
  | { type: "OPEN_SELECTOR" }
  | { type: "CLOSE_SELECTOR" }
  | { type: "BACK" }
  | { type: "NAME_CHANGED"; name: string }
  | { type: "TOGGLE_LEAF"; identity: string }
  | { type: "RANGE_TO_LEAF"; identity: string; visibleLeaves: string[] }
  | { type: "TOGGLE_CONTAINER"; prefix: string }
  | { type: "SET_ALL_VISIBLE"; identities: string[]; selected: boolean }
  | { type: "RUN_STARTED" }
  | { type: "PROGRESS"; progress: WireProcessProgress }
  | { type: "PUBLISHED"; report: ImportRunReport }
  | { type: "RUN_FAILED"; message: string; outcome?: ImportRunReport["outcome"] }
  | { type: "RUN_CANCELLED" }
  | { type: "RETRY" }
  | { type: "EXIT_REQUESTED" }
  | { type: "RESET" };

/**
 * Whether an item may be chosen for import — the UI mirror of the trusted
 * routing rule (`event_importable` in core): only selectable log-role
 * content ever becomes events. Supporting material, ignored noise,
 * unsupported content, and blocked entries are visible, counted, and never
 * selectable.
 */
export function isSelectable(item: WireImportPreviewItem): boolean {
  return item.status !== "blocked" && item.role === "log";
}

/** Whether an item would produce log events when imported. */
export function isImportableAsEvents(item: WireImportPreviewItem): boolean {
  return isSelectable(item);
}

/** Deterministic preselection straight from the trusted preview. */
export function preselectedIdentities(report: WireImportPreviewReport): Set<string> {
  const selected = new Set<string>();
  for (const item of report.items) {
    if (item.selected && isSelectable(item)) selected.add(item.identity);
  }
  return selected;
}

/**
 * The exact allowlist for a run: every selected, event-importable identity
 * in report order. The engine re-verifies this against a fresh enumeration
 * and its plan token, so anything outside this list — deselected rows,
 * supporting material, blocked entries, an unreviewed truncation tail —
 * can never import.
 */
export function selectedForRun(state: ImportFlowState): string[] {
  const report = state.report;
  if (!report) return [];
  return report.items
    .filter((item) => isImportableAsEvents(item) && state.selected.has(item.identity))
    .map((item) => item.identity);
}

/** Count of selected sources that will produce events. */
export function selectedImportableCount(state: ImportFlowState): number {
  const report = state.report;
  if (!report) return 0;
  return report.items.filter(
    (item) => isImportableAsEvents(item) && state.selected.has(item.identity),
  ).length;
}

/**
 * Why the Import action is disabled, or null when it may proceed. The
 * string renders inline next to the disabled control — a disabled primary
 * always explains itself.
 */
export function importDisabledReason(state: ImportFlowState): string | null {
  if (!state.report) return "Choose a folder, files, or an archive first.";
  if (selectedImportableCount(state) === 0) {
    return "Nothing selected would import as log events. Select at least one log source.";
  }
  return null;
}

/**
 * Flow-through rule: the selector stage is required before import only when
 * a blocking decision exists. Review-state sources import as matched by
 * detection and stay reviewable after publication, so uncertainty alone
 * never forces the selector — but a preview with nothing importable does.
 */
export function selectorRequired(state: ImportFlowState): boolean {
  return selectedImportableCount(state) === 0;
}

/** One row of the container tree: either a leaf item or a container line. */
export type SelectorRow =
  | { kind: "leaf"; item: WireImportPreviewItem; depth: number }
  | {
      kind: "container";
      prefix: string;
      label: string;
      depth: number;
      leafIdentities: string[];
    };

/**
 * Container prefixes of an identity, outermost first. Directory segments and
 * archive boundaries both open containers:
 * `support.zip!/host-a.zip!/logs/app.log` →
 * `support.zip!/`, `support.zip!/host-a.zip!/`, `support.zip!/host-a.zip!/logs/`.
 */
export function containerPrefixes(identity: string): string[] {
  const prefixes: string[] = [];
  let index = 0;
  while (index < identity.length) {
    const bang = identity.indexOf("!/", index);
    const slash = identity.indexOf("/", index);
    let cut = -1;
    if (bang !== -1 && (slash === -1 || bang <= slash)) {
      cut = bang + 2;
    } else if (slash !== -1) {
      cut = slash + 1;
    }
    if (cut === -1 || cut >= identity.length) break;
    prefixes.push(identity.slice(0, cut));
    index = cut;
  }
  return prefixes;
}

/**
 * Flatten the report into visible rows honoring collapsed containers and a
 * status filter. Deterministic: items keep report order; containers appear
 * before their first member.
 */
export function selectorRows(
  report: WireImportPreviewReport,
  options: {
    collapsed: ReadonlySet<string>;
    statusFilter: ReadonlySet<string> | null;
    query: string;
  },
): SelectorRow[] {
  const rows: SelectorRow[] = [];
  const emitted = new Set<string>();
  const query = options.query.trim().toLowerCase();
  const leavesByPrefix = new Map<string, string[]>();
  const visibleItems = report.items.filter((item) => {
    if (options.statusFilter && !options.statusFilter.has(item.status)) return false;
    if (query && !item.identity.toLowerCase().includes(query)) return false;
    return true;
  });
  for (const item of visibleItems) {
    for (const prefix of containerPrefixes(item.identity)) {
      const existing = leavesByPrefix.get(prefix);
      if (existing) existing.push(item.identity);
      else leavesByPrefix.set(prefix, [item.identity]);
    }
  }
  for (const item of visibleItems) {
    const prefixes = containerPrefixes(item.identity);
    let hiddenByCollapse = false;
    for (const prefix of prefixes) {
      if (!emitted.has(prefix)) {
        emitted.add(prefix);
        const parentCollapsed = containerPrefixes(prefix.slice(0, -1)).some((outer) =>
          options.collapsed.has(outer),
        );
        if (!parentCollapsed) {
          rows.push({
            kind: "container",
            prefix,
            label: prefix,
            depth: containerPrefixes(prefix.slice(0, -1)).length,
            leafIdentities: leavesByPrefix.get(prefix) ?? [],
          });
        }
      }
      if (options.collapsed.has(prefix)) hiddenByCollapse = true;
    }
    if (!hiddenByCollapse) {
      rows.push({ kind: "leaf", item, depth: prefixes.length });
    }
  }
  return rows;
}

/** Tri-state of a container over the current selection. */
export function containerState(
  leafIdentities: string[],
  report: WireImportPreviewReport,
  selected: ReadonlySet<string>,
): "checked" | "unchecked" | "mixed" | "none" {
  const byIdentity = new Map(report.items.map((item) => [item.identity, item]));
  const selectable = leafIdentities.filter((identity) => {
    const item = byIdentity.get(identity);
    return item ? isSelectable(item) : false;
  });
  if (selectable.length === 0) return "none";
  const on = selectable.filter((identity) => selected.has(identity)).length;
  if (on === 0) return "unchecked";
  if (on === selectable.length) return "checked";
  return "mixed";
}

function withSelection(state: ImportFlowState, selected: Set<string>): ImportFlowState {
  return { ...state, selected };
}

function itemByIdentity(
  state: ImportFlowState,
  identity: string,
): WireImportPreviewItem | undefined {
  return state.report?.items.find((item) => item.identity === identity);
}

/** The pure reducer. Unknown events in a stage are ignored, never throw. */
export function importFlowReducer(
  state: ImportFlowState,
  event: ImportFlowEvent,
): ImportFlowState {
  switch (event.type) {
    case "PATH_CHOSEN":
      return {
        ...INITIAL_IMPORT_FLOW_STATE,
        corpusName: state.corpusName,
        path: event.path,
        stage: "previewing",
      };
    case "PREVIEW_OK": {
      if (state.stage !== "previewing") return state;
      const selected = preselectedIdentities(event.plan.report);
      const next: ImportFlowState = {
        ...state,
        plan: event.plan,
        report: event.plan.report,
        selected,
        error: null,
      };
      // Flow-through: land on the selector only when a decision is forced.
      return { ...next, stage: selectorRequired(next) ? "selector" : "preflight" };
    }
    case "PREVIEW_FAILED":
      if (state.stage !== "previewing") return state;
      return { ...state, stage: "preview_failed", error: event.message };
    case "OPEN_SELECTOR":
      if (state.stage !== "preflight") return state;
      return { ...state, stage: "selector" };
    case "CLOSE_SELECTOR":
      if (state.stage !== "selector") return state;
      return { ...state, stage: "preflight" };
    case "BACK":
      if (state.stage === "selector") return { ...state, stage: "preflight" };
      if (state.stage === "preflight" || state.stage === "preview_failed") {
        return { ...INITIAL_IMPORT_FLOW_STATE, corpusName: state.corpusName };
      }
      return state;
    case "NAME_CHANGED":
      return { ...state, corpusName: event.name };
    case "TOGGLE_LEAF": {
      const item = itemByIdentity(state, event.identity);
      if (!item || !isSelectable(item)) return state;
      const selected = new Set(state.selected);
      if (selected.has(event.identity)) selected.delete(event.identity);
      else selected.add(event.identity);
      return { ...withSelection(state, selected), rangeAnchor: event.identity };
    }
    case "RANGE_TO_LEAF": {
      // Leaf-only ranges over the flattened visible order: containers inside
      // the range re-derive; the anchor's current value paints the range.
      const anchor = state.rangeAnchor;
      if (!anchor || !state.report) {
        return importFlowReducer(state, { type: "TOGGLE_LEAF", identity: event.identity });
      }
      const from = event.visibleLeaves.indexOf(anchor);
      const to = event.visibleLeaves.indexOf(event.identity);
      if (from === -1 || to === -1) {
        return importFlowReducer(state, { type: "TOGGLE_LEAF", identity: event.identity });
      }
      const [start, end] = from <= to ? [from, to] : [to, from];
      const paint = state.selected.has(anchor);
      const selected = new Set(state.selected);
      for (const identity of event.visibleLeaves.slice(start, end + 1)) {
        const item = itemByIdentity(state, identity);
        if (!item || !isSelectable(item)) continue;
        if (paint) selected.add(identity);
        else selected.delete(identity);
      }
      return withSelection(state, selected);
    }
    case "TOGGLE_CONTAINER": {
      if (!state.report) return state;
      const leaves = state.report.items
        .filter((item) => item.identity.startsWith(event.prefix) && isSelectable(item))
        .map((item) => item.identity);
      if (leaves.length === 0) return state;
      const allOn = leaves.every((identity) => state.selected.has(identity));
      const selected = new Set(state.selected);
      for (const identity of leaves) {
        if (allOn) selected.delete(identity);
        else selected.add(identity);
      }
      return withSelection(state, selected);
    }
    case "SET_ALL_VISIBLE": {
      if (!state.report) return state;
      const selected = new Set(state.selected);
      for (const identity of event.identities) {
        const item = itemByIdentity(state, identity);
        if (!item || !isSelectable(item)) continue;
        if (event.selected) selected.add(identity);
        else selected.delete(identity);
      }
      return withSelection(state, selected);
    }
    case "RUN_STARTED":
      if (state.stage !== "preflight" && state.stage !== "selector") return state;
      if (importDisabledReason(state) !== null) return state;
      return {
        ...state,
        stage: "running",
        progress: null,
        error: null,
        errorOutcome: undefined,
        exitRequested: false,
      };
    case "PROGRESS":
      if (state.stage !== "running") return state;
      return { ...state, progress: event.progress };
    case "PUBLISHED":
      if (state.stage !== "running") return state;
      return { ...state, stage: "summary", runReport: event.report };
    case "RUN_FAILED":
      if (state.stage !== "running") return state;
      return {
        ...state,
        stage: "run_failed",
        error: event.message,
        errorOutcome: event.outcome,
      };
    case "RUN_CANCELLED":
      if (state.stage !== "running") return state;
      return { ...state, stage: "run_cancelled", error: null };
    case "RETRY":
      if (state.stage !== "run_failed" && state.stage !== "run_cancelled") return state;
      return {
        ...state,
        stage: "preflight",
        error: null,
        errorOutcome: undefined,
        progress: null,
        exitRequested: false,
      };
    case "EXIT_REQUESTED":
      if (state.stage !== "running") return state;
      return { ...state, exitRequested: true };
    case "RESET":
      return { ...INITIAL_IMPORT_FLOW_STATE, corpusName: state.corpusName };
    default:
      return state;
  }
}

/** Plain-language explanation for each ledger state chip. */
export const STATUS_EXPLANATIONS: Record<string, string> = {
  ready: "Format matched — imports as log events.",
  review: "Uncertain format — imports as detected now; review stays available after import.",
  raw_fallback: "No structured match — imports as raw lines. Keeping raw is the honest default.",
  supporting: "Supporting material or an unsupported event format. Never imported as events.",
  ignored: "Kept out by policy (hidden or bookkeeping). Counted, never silent.",
  unsupported: "Cannot be read as log text (binary or empty).",
  blocked: "Refused by a safety bound. Never importable.",
};

/** Short chip labels for the seven ledger states. */
export const STATUS_LABELS: Record<string, string> = {
  ready: "Ready",
  review: "Review",
  raw_fallback: "Raw",
  supporting: "Supporting",
  ignored: "Ignored",
  unsupported: "Unsupported",
  blocked: "Blocked",
};

/** Reason codes rendered as plain language (stable, content-free). */
export const REASON_EXPLANATIONS: Record<string, string> = {
  manifest_declared: "Declared by a validated evidence-bundle manifest",
  strong_format_match: "Strong deterministic format match",
  ambiguous_format_match: "Multiple formats fit this source",
  mixed_format_records: "Different samples matched different formats",
  no_structured_match: "No structured grammar matched",
  insufficient_event_evidence: "Not enough repeated event records for automatic log import",
  xml_event_parsing_unsupported: "XML event parsing is not supported yet",
  html_event_parsing_unsupported: "HTML event parsing is not supported yet",
  binary_content: "Binary content",
  empty_content: "Empty file",
  oversized: "Larger than the per-file limit",
  hidden: "Hidden file",
  symlink_rejected: "Symbolic link — refused by policy",
  non_regular_rejected: "Not a regular file",
  archive_depth_exceeded: "Nested deeper than 3 archives — not expanded",
  compression_ratio_exceeded: "Decompression ratio beyond the safety limit",
  traversal_rejected: "Path escapes its archive",
  duplicate_identity: "Duplicate identity inside the archive",
  encrypted_entry: "Encrypted archive entry",
  read_failed: "Could not be read",
  metrics_document: "Operational metrics document",
  readme_document: "Bundle documentation",
  weak_name_hint_only: "Only the name suggested a format; content disagreed",
  nested_archive_not_inventoried: "Nested archive too large to inventory in preview",
};

/** Deterministic timezone group key: format identity + unresolved reasons. */
export function timezoneGroupKey(source: {
  formatId?: string;
  unresolvedReasons?: string[];
}): string {
  return `${source.formatId ?? "unknown-format"}·${[
    ...(source.unresolvedReasons ?? []),
  ]
    .sort()
    .join("+")}`;
}

export type TimezoneGroup = {
  key: string;
  label: string;
  sources: string[];
  records: number;
};

/** Deterministic exception groups over unresolved sources. */
export function timezoneGroups(report: ImportRunReport): TimezoneGroup[] {
  const groups = new Map<string, TimezoneGroup>();
  for (const source of report.confidence.sources) {
    const unresolvedReasons = source.unresolvedReasons ?? [];
    // Order-only can also mean that the source has no timestamp at all. Only
    // sources with a parser-validated local timestamp belong in timezone
    // review; Rust intentionally omits empty vectors from the wire.
    if (source.timeQuality === "wall" || unresolvedReasons.length === 0) continue;
    const key = timezoneGroupKey(source);
    const reasonLabel = unresolvedReasons.includes("zone_abbreviation_not_resolved")
      ? "zone abbreviation not resolved"
      : "no timezone";
    const formatLabel = source.formatId ?? "unmatched format";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: `${formatLabel} · ${reasonLabel}`, sources: [], records: 0 };
      groups.set(key, group);
    }
    group.sources.push(source.source);
    group.records += source.lines;
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Classified import class from the host document.
 *
 * Fail-closed both ways: only an explicit `complete` class may render as
 * complete, and a class the host did not state is never invented. A report
 * carrying only the legacy `partial` bool keeps the class that bool has
 * always declared; a report with no class signal at all is `unknown` —
 * published, but uncertified, and never presented as complete or as a
 * defect-ledger PARTIAL the host never claimed.
 */
export function classifiedImportClass(
  report: ImportRunReport | null | undefined,
): ImportOutcomeClass | "unknown" {
  if (!report) return "rejected";
  const cls = report.outcome?.class;
  if (cls === "complete" || cls === "partial" || cls === "rejected") return cls;
  if (report.partial) return "partial";
  return "unknown";
}

/** IANA zone gate matching the shipped review dialog's rule. */
export function isValidIanaZone(zone: string): boolean {
  const trimmed = zone.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (trimmed === "UTC") return true;
  return trimmed.includes("/") && !trimmed.includes(" ");
}
