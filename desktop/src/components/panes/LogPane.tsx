/**
 * Log analysis surface: Memory-style list | detail + package import/export.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  hostDiscardLogCorpus,
  hostExportLogCorpusPackage,
  hostClearFailedLogIngestDiagnostic,
  hostGetBranding,
  hostGetFailedLogIngestDiagnostic,
  hostImportLogCorpusPackagePath,
  hostCancelLogIngest,
  hostCancelLogReanalysis,
  hostIngestLogPath,
  hostListLogCorpora,
  hostListLogTemplates,
  hostListenProcessProgress,
  hostLogClusterProblems,
  hostLogSearch,
  hostOpenLogExplorer,
  hostReanalyzeLogCorpus,
  hostSetActiveLogCorpus,
  type LogClusterDto,
  type LogCorpusSummaryDto,
  type FailedLogIngestDiagnosticDto,
  type LogSearchHitDto,
  type LogTemplateRowDto,
  type ProcessProgressDto,
} from "../../lib/host";
import {
  dialogConfirm,
  openDirectoryDialog,
  openFileDialog,
  saveFileDialog,
} from "../../lib/dialogs";
import {
  formatBytes,
  formatEventsPerTemplate,
  levelEntries,
  statsBlurb,
} from "../../lib/logStats";
import {
  diagnosticEnvironmentFromBranding,
  portableDiagnosticOsHint,
  type LogDiagnosticEnvironment,
  type LogDiagnosticStatus,
} from "../../lib/logDiagnosticReport";
import { HELP_TEMPLATE_GROUPING } from "../../lib/helpContent";
import { HelpTip } from "../HelpTip";
import { ProcessProgressPanel } from "../wizards/ProcessProgressPanel";
import type { ProcessProgressDto as WizardProgressDto } from "../wizards/types";
import { LogExplorer } from "../logExplorer/LogExplorer";
import { LogDiagnosticDialog } from "./LogDiagnosticDialog";

function hostProgressToWizard(p: ProcessProgressDto): WizardProgressDto {
  return {
    kind: p.kind,
    phase: p.phase as WizardProgressDto["phase"],
    message: p.message,
    fraction: p.fraction,
    lines_processed: p.lines_processed,
    files_processed: p.files_processed,
    bytes_processed: p.bytes_processed,
    templates: p.templates,
    cancellable: p.cancellable,
  };
}

type DetailTab = "overview" | "search" | "templates" | "analysis";

type CorpusAnalysis = {
  status: "idle" | "loading" | "ready" | "error";
  clusters: LogClusterDto[];
  templates: LogTemplateRowDto[];
  error: string | null;
};

function analysisFingerprint(corpus: LogCorpusSummaryDto): string {
  const embedding = corpus.embedding;
  return [
    corpus.eventCount,
    corpus.templateCount,
    embedding?.state ?? "legacy",
    embedding?.embeddedTemplates ?? corpus.stats?.embedded ?? 0,
    embedding?.totalTemplates ?? corpus.templateCount,
    embedding?.updatedAt ?? 0,
  ].join(":");
}

const EMPTY_ANALYSIS: CorpusAnalysis = {
  status: "idle",
  clusters: [],
  templates: [],
  error: null,
};

type Props = {
  pickDirectory?: () => Promise<string | null>;
  onOpenHelp?: (pageId: string) => void;
};

function CorpusOverflowGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="3" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="13" r="1.25" fill="currentColor" />
    </svg>
  );
}

export function LogPane({ pickDirectory, onOpenHelp }: Props) {
  const [corpora, setCorpora] = useState<LogCorpusSummaryDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [busy, setBusy] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LogSearchHitDto[]>([]);
  const [analysisByCorpus, setAnalysisByCorpus] = useState<
    Record<string, CorpusAnalysis>
  >({});
  const [exemplar, setExemplar] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProcessProgressDto | null>(null);
  const [failedIngestDiagnostic, setFailedIngestDiagnostic] =
    useState<FailedLogIngestDiagnosticDto | null>(null);
  /** In-app Explorer escape hatch when multi-window fails (#503). */
  const [inAppExplorerId, setInAppExplorerId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<{
    corpus: LogCorpusSummaryDto | null;
    failedIngest: FailedLogIngestDiagnosticDto | null;
    environment: LogDiagnosticEnvironment;
    currentStatus: LogDiagnosticStatus | null;
  } | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const analysisCacheRef = useRef(new Map<string, CorpusAnalysis>());
  const analysisInFlightRef = useRef(new Map<string, Promise<void>>());
  const analysisRequestTokenRef = useRef(new Map<string, symbol>());
  /** Corpus-analysis fingerprint so re-analysis and growth invalidate stale cache. */
  const analysisFingerprintRef = useRef(new Map<string, string>());
  /** Selection generation and queue keep the trusted host's final corpus newest. */
  const selectGenerationRef = useRef(0);
  const hostSelectionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeIdRef = useRef<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const corpusButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingDiscardFocusRef = useRef<string | null | undefined>(undefined);
  const failedDiagnosticTriggerRef = useRef<HTMLButtonElement>(null);
  const importLogsTriggerRef = useRef<HTMLButtonElement>(null);
  const analysisStatusId = useId();
  const analysisDescriptionId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void hostListenProcessProgress((p) => {
      if (p.kind === "log_ingest") setProgress(p);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const clearAnalysisForCorpus = useCallback((id: string) => {
    // Invalidate any in-flight token so late host replies cannot re-seed cache.
    analysisRequestTokenRef.current.delete(id);
    analysisInFlightRef.current.delete(id);
    analysisCacheRef.current.delete(id);
    analysisFingerprintRef.current.delete(id);
    if (!mountedRef.current) return;
    setAnalysisByCorpus((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    try {
      const list = (await hostListLogCorpora()) ?? [];
      if (
        !mountedRef.current ||
        generation !== refreshGenerationRef.current
      ) {
        return;
      }
      const liveIds = new Set(list.map((c) => c.id));
      // Drop analysis for discarded corpora; invalidate when event/template or
      // embedding metadata changes so local re-analysis cannot leave stale
      // clusters under an unchanged event count.
      for (const id of [...analysisCacheRef.current.keys()]) {
        if (!liveIds.has(id)) {
          clearAnalysisForCorpus(id);
        }
      }
      for (const c of list) {
        const prev = analysisFingerprintRef.current.get(c.id);
        const next = analysisFingerprint(c);
        if (prev !== undefined && prev !== next) {
          clearAnalysisForCorpus(c.id);
        }
        analysisFingerprintRef.current.set(c.id, next);
      }
      for (const id of [...analysisFingerprintRef.current.keys()]) {
        if (!liveIds.has(id)) {
          analysisFingerprintRef.current.delete(id);
        }
      }
      setCorpora(list);
    } catch (e) {
      if (
        !mountedRef.current ||
        generation !== refreshGenerationRef.current
      ) {
        return;
      }
      setError(String(e));
    }
  }, [clearAnalysisForCorpus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void hostGetFailedLogIngestDiagnostic()
      .then(setFailedIngestDiagnostic)
      .catch(() => {
        /* The optional transient diagnostic must not block Logs. */
      });
  }, []);

  const closeCorpusMenu = useCallback(
    (restoreFocus = true) => {
      const closingId = openMenuId;
      setOpenMenuId(null);
      setMenuPosition(null);
      if (restoreFocus && closingId) {
        queueMicrotask(() => menuTriggerRefs.current.get(closingId)?.focus());
      }
    },
    [openMenuId],
  );

  const positionCorpusMenu = useCallback(() => {
    if (!openMenuId) return;
    const trigger = menuTriggerRefs.current.get(openMenuId);
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const gutter = 8;
    const offset = 4;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(
      gutter,
      window.innerWidth - menuRect.width - gutter,
    );
    const left = Math.min(
      Math.max(gutter, triggerRect.right - menuRect.width),
      maxLeft,
    );
    const below = triggerRect.bottom + offset;
    const top =
      below + menuRect.height <= window.innerHeight - gutter
        ? below
        : Math.max(gutter, triggerRect.top - menuRect.height - offset);

    setMenuPosition({ left, top });
  }, [openMenuId]);

  useLayoutEffect(() => {
    if (!openMenuId) return;
    positionCorpusMenu();
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, [openMenuId, positionCorpusMenu]);

  useEffect(() => {
    if (!openMenuId) return;

    const trigger = menuTriggerRefs.current.get(openMenuId);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        !target ||
        menuRef.current?.contains(target) ||
        trigger?.contains(target)
      ) {
        return;
      }
      const otherTrigger =
        target instanceof Element
          ? target.closest("[data-log-corpus-menu-trigger]")
          : null;
      closeCorpusMenu(!otherTrigger);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeCorpusMenu();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (
        !target ||
        menuRef.current?.contains(target) ||
        trigger?.contains(target)
      ) {
        return;
      }
      closeCorpusMenu(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("scroll", positionCorpusMenu, true);
    window.addEventListener("resize", positionCorpusMenu);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("scroll", positionCorpusMenu, true);
      window.removeEventListener("resize", positionCorpusMenu);
    };
  }, [closeCorpusMenu, openMenuId, positionCorpusMenu]);

  useEffect(() => {
    if (openMenuId && !corpora.some((corpus) => corpus.id === openMenuId)) {
      setOpenMenuId(null);
      setMenuPosition(null);
    }
  }, [corpora, openMenuId]);

  useEffect(() => {
    const pendingId = pendingDiscardFocusRef.current;
    if (pendingId === undefined) return;
    if (pendingId) {
      const target = corpusButtonRefs.current.get(pendingId);
      if (!target) return;
      target.focus();
    } else {
      listRef.current?.focus();
    }
    pendingDiscardFocusRef.current = undefined;
  }, [corpora]);

  const selectCorpus = useCallback(async (id: string) => {
    // Critical path: flip local selection immediately. Do not await cluster or
    // template analysis — that is on-demand via loadAnalysis (#743).
    const generation = ++selectGenerationRef.current;
    activeIdRef.current = id;
    setActiveId(id);
    setTab("overview");
    setHits([]);
    setExemplar(null);
    setError(null);
    const queued = hostSelectionQueueRef.current
      .catch(() => {
        /* A prior host activation is non-fatal; continue to the newest pick. */
      })
      .then(async () => {
        // If another selection arrived before this request began, skip the
        // obsolete host mutation. Once a request has begun, the next queued
        // selection necessarily runs after it, so the host finishes newest.
        if (selectGenerationRef.current !== generation) return;
        try {
          await hostSetActiveLogCorpus(id);
        } catch (activationError) {
          if (selectGenerationRef.current === generation) {
            setError(
              `Could not activate "${id}" for Explorer and chat: ${String(activationError)}`,
            );
          }
        }
      });
    hostSelectionQueueRef.current = queued;
    await queued;
  }, []);

  const writeAnalysis = useCallback((id: string, value: CorpusAnalysis) => {
    analysisCacheRef.current.set(id, value);
    if (!mountedRef.current) return;
    setAnalysisByCorpus((current) => ({ ...current, [id]: value }));
  }, []);

  // #743: corpus activation must stay cheap. Cluster/template queries are
  // bounded but can still be expensive for large corpora, so they run only
  // after an explicit request. Results are cached by corpus and concurrent
  // requests are coalesced; late results can update only their own corpus.
  const loadAnalysis = useCallback(
    (id: string, force = false) => {
      const inFlight = analysisInFlightRef.current.get(id);
      if (inFlight) return inFlight;

      const cached = analysisCacheRef.current.get(id);
      if (!force && cached?.status === "ready") {
        return Promise.resolve();
      }

      writeAnalysis(id, {
        status: "loading",
        clusters: cached?.clusters ?? [],
        templates: cached?.templates ?? [],
        error: null,
      });

      const requestToken = Symbol(id);
      analysisRequestTokenRef.current.set(id, requestToken);
      // Fingerprint at request start so a later re-ingest of the same id cannot
      // accept results computed against the previous event count.
      const fingerprintAtStart =
        analysisFingerprintRef.current.get(id) ?? null;
      const request = Promise.allSettled([
        hostLogClusterProblems(id, 12),
        hostListLogTemplates(id, 100),
      ])
        .then(([clusterResult, templateResult]) => {
          if (analysisRequestTokenRef.current.get(id) !== requestToken) return;
          const fpNow = analysisFingerprintRef.current.get(id) ?? null;
          if (fingerprintAtStart !== null && fpNow !== fingerprintAtStart) return;
          if (
            clusterResult.status === "rejected" ||
            templateResult.status === "rejected"
          ) {
            const reasons = [clusterResult, templateResult]
              .filter(
                (
                  result,
                ): result is PromiseRejectedResult =>
                  result.status === "rejected",
              )
              .map((result) => String(result.reason));
            writeAnalysis(id, {
              status: "error",
              clusters:
                clusterResult.status === "fulfilled"
                  ? (clusterResult.value ?? [])
                  : (cached?.clusters ?? []),
              templates:
                templateResult.status === "fulfilled"
                  ? (templateResult.value ?? [])
                  : (cached?.templates ?? []),
              error: reasons.join(" · "),
            });
            return;
          }
          writeAnalysis(id, {
            status: "ready",
            clusters: clusterResult.value ?? [],
            templates: templateResult.value ?? [],
            error: null,
          });
        })
        .finally(() => {
          if (analysisInFlightRef.current.get(id) === request) {
            analysisInFlightRef.current.delete(id);
          }
          if (analysisRequestTokenRef.current.get(id) === requestToken) {
            analysisRequestTokenRef.current.delete(id);
          }
        });
      analysisInFlightRef.current.set(id, request);
      return request;
    },
    [writeAnalysis],
  );

  const active = corpora.find((c) => c.id === activeId) ?? null;
  const activeAnalysis = activeId
    ? (analysisByCorpus[activeId] ?? EMPTY_ANALYSIS)
    : EMPTY_ANALYSIS;
  const activeEmbedding = active?.embedding ?? {
    state:
      (active?.stats?.embedded ?? 0) > 0
        ? ("partial" as const)
        : ("keyword_only" as const),
    modelId: null,
    embeddedTemplates: active?.stats?.embedded ?? 0,
    totalTemplates: active?.templateCount ?? 0,
    reason: "legacy_metadata",
    updatedAt: 0,
  };
  const semanticAvailable = activeEmbedding.embeddedTemplates > 0;

  async function onImportLogs() {
    const picker =
      pickDirectory ?? (() => openDirectoryDialog("Choose log directory"));
    const dir = await picker();
    let path = dir;
    if (!path) {
      path = await openFileDialog("Choose log file or zip", [
        { name: "Logs", extensions: ["log", "txt", "json", "jsonl", "zip"] },
      ]);
    }
    if (!path) return;
    const ok = await dialogConfirm(
      "SoftWrite: ingest into a disposable analysis corpus (secrets redacted). Continue?",
      { title: "Import logs" },
    );
    if (!ok) return;
    setBusy(true);
    setIngesting(true);
    setError(null);
    setNote(null);
    setProgress(null);
    setFailedIngestDiagnostic(null);
    try {
      const r = await hostIngestLogPath(path, "incident");
      setNote(statsBlurb(r));
      await refresh();
      await selectCorpus(r.corpusId);
    } catch (e) {
      setError(String(e));
      try {
        setFailedIngestDiagnostic(
          await hostGetFailedLogIngestDiagnostic(),
        );
      } catch {
        /* Preserve the visible ingest error if diagnostic retrieval fails. */
      }
    } finally {
      setBusy(false);
      setIngesting(false);
    }
  }

  async function onImportPackage() {
    const path = await openFileDialog("Import log corpus package", [
      { name: "ContextDesk package", extensions: ["zip", "cdlog"] },
    ]);
    if (!path) return;
    const ok = await dialogConfirm(
      "SoftWrite: import a portable analysis package (new disposable corpus). Continue?",
      { title: "Import package" },
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setFailedIngestDiagnostic(null);
    try {
      const r = await hostImportLogCorpusPackagePath(path);
      setNote(
        `Imported package → corpus ${r.corpusId} (from ${r.originCorpusId})`,
      );
      await refresh();
      await selectCorpus(r.corpusId);
    } catch (e) {
      // Surface version/hash errors as human-readable
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onExportPackage() {
    if (!activeId) return;
    const path = await saveFileDialog(
      "Export log corpus package",
      "corpus.cdlog.zip",
      [{ name: "ContextDesk package", extensions: ["zip"] }],
    );
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const ver = await hostExportLogCorpusPackage(activeId, path);
      setNote(`Exported package (${ver})`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReanalyze() {
    if (!activeId) return;
    const ok = await dialogConfirm(
      "Re-analyze this corpus with the local ONNX model? Log content stays on this machine, events are not reparsed, and the current keyword corpus remains usable until the new index is complete.",
      { title: "Local template re-analysis" },
    );
    if (!ok) return;
    setBusy(true);
    setReanalyzing(true);
    setError(null);
    setNote(null);
    setProgress(null);
    try {
      const status = await hostReanalyzeLogCorpus(activeId);
      setNote(
        `Local re-analysis complete: ${status.embeddedTemplates.toLocaleString()}/${status.totalTemplates.toLocaleString()} templates embedded.`,
      );
      // A successful re-analysis can change clusters/templates without changing
      // the corpus row count or host summary timestamp. Never retain the prior
      // optional-analysis snapshot in that case.
      clearAnalysisForCorpus(activeId);
      await refresh();
      await selectCorpus(activeId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setReanalyzing(false);
    }
  }

  async function onSearch() {
    if (!activeId || !query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const h = await hostLogSearch(activeId, query.trim(), 12);
      setHits(h ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDiscard(id: string) {
    const corpus = corpora.find((candidate) => candidate.id === id);
    const trigger = menuTriggerRefs.current.get(id);
    setOpenMenuId(null);
    setMenuPosition(null);
    queueMicrotask(() => trigger?.focus());

    const ok = await dialogConfirm(
      `Discard "${corpus?.name ?? "this corpus"}"? This removes the disposable analysis corpus from ContextDesk.`,
      {
        title: "Discard corpus",
        kind: "warning",
      },
    );
    if (!ok) {
      queueMicrotask(() => trigger?.focus());
      return;
    }

    const discardedIndex = corpora.findIndex(
      (candidate) => candidate.id === id,
    );
    const remaining = corpora.filter((candidate) => candidate.id !== id);
    pendingDiscardFocusRef.current =
      remaining[Math.min(Math.max(discardedIndex, 0), remaining.length - 1)]
        ?.id ?? null;

    setBusy(true);
    try {
      await hostDiscardLogCorpus(id);
      clearAnalysisForCorpus(id);
      if (activeIdRef.current === id) {
        activeIdRef.current = null;
        setActiveId(null);
        setHits([]);
      }
      await refresh();
    } catch (e) {
      pendingDiscardFocusRef.current = undefined;
      setError(String(e));
      queueMicrotask(() => trigger?.focus());
    } finally {
      setBusy(false);
    }
  }

  async function onOpenDiagnostics(id: string) {
    const corpus = corpora.find((candidate) => candidate.id === id);
    if (!corpus) return;
    const currentStatus: LogDiagnosticStatus | null = error
      ? { kind: "error", message: error }
      : note
        ? { kind: "status", message: note }
        : null;
    setOpenMenuId(null);
    setMenuPosition(null);
    let environment: LogDiagnosticEnvironment = {
      appVersion: "unknown",
      channel: "unknown",
      gitSha: null,
      os: portableDiagnosticOsHint(),
    };
    try {
      environment = diagnosticEnvironmentFromBranding(await hostGetBranding());
    } catch {
      /* Keep an honest unknown identity if host branding is unavailable. */
    }
    setDiagnostic({
      corpus,
      failedIngest: null,
      currentStatus,
      environment,
    });
  }

  async function onOpenFailedIngestDiagnostics() {
    if (!failedIngestDiagnostic) return;
    let environment: LogDiagnosticEnvironment = {
      appVersion: "unknown",
      channel: "unknown",
      gitSha: null,
      os: portableDiagnosticOsHint(),
    };
    try {
      environment = diagnosticEnvironmentFromBranding(await hostGetBranding());
    } catch {
      /* Keep an honest unknown identity if host branding is unavailable. */
    }
    setDiagnostic({
      corpus: null,
      failedIngest: failedIngestDiagnostic,
      currentStatus: null,
      environment,
    });
  }

  async function clearFailedIngestDiagnostic() {
    try {
      await hostClearFailedLogIngestDiagnostic();
    } finally {
      setFailedIngestDiagnostic(null);
      queueMicrotask(() => importLogsTriggerRef.current?.focus());
    }
  }

  function closeDiagnostics() {
    const corpusId = diagnostic?.corpus?.id;
    const failed = diagnostic?.failedIngest != null;
    setDiagnostic(null);
    if (corpusId) {
      queueMicrotask(() => menuTriggerRefs.current.get(corpusId)?.focus());
    } else if (failed) {
      queueMicrotask(() => failedDiagnosticTriggerRef.current?.focus());
    }
  }

  function openCorpusMenu(
    id: string,
    event?: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    event?.preventDefault();
    setMenuPosition(null);
    setOpenMenuId(id);
  }

  function onMenuItemKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      if (items.length === 0) return;
      const current = Math.max(items.indexOf(event.currentTarget), 0);
      const target =
        event.key === "Home"
          ? items[0]
          : event.key === "End"
            ? items.at(-1)
            : event.key === "ArrowDown"
              ? items[(current + 1) % items.length]
              : items[(current - 1 + items.length) % items.length];
      target?.focus();
    }
  }

  function renderAnalysisLoadControl() {
    if (!activeId) return null;

    const isLoading = activeAnalysis.status === "loading";
    const actionLabel =
      activeAnalysis.status === "ready"
        ? "Refresh analysis"
        : activeAnalysis.status === "error"
          ? "Retry analysis"
          : isLoading
            ? "Loading analysis…"
            : "Load analysis";
    const statusMessage =
      activeAnalysis.status === "ready"
        ? `Loaded ${activeAnalysis.templates.length.toLocaleString()} templates and ${activeAnalysis.clusters.length.toLocaleString()} problem clusters.`
        : activeAnalysis.status === "error"
          ? "Analysis could not be loaded. The corpus and its menu remain available."
          : isLoading
            ? "Loading up to 100 templates and 12 problem clusters. You can keep selecting and managing corpora."
            : "Analysis is not loaded automatically, keeping large-corpus selection responsive.";

    return (
      <section
        className="log-analysis-load"
        aria-busy={isLoading}
        aria-labelledby={analysisStatusId}
      >
        <div className="log-analysis-load__copy">
          <strong id={analysisStatusId}>On-demand analysis</strong>
          <span
            id={analysisDescriptionId}
            className="muted"
            role="status"
            aria-live="polite"
          >
            {statusMessage}
          </span>
          {activeAnalysis.error ? (
            <span className="error" role="alert">
              {activeAnalysis.error}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn--ghost"
          aria-disabled={isLoading}
          aria-describedby={analysisDescriptionId}
          onClick={() => {
            if (isLoading) return;
            void loadAnalysis(activeId, activeAnalysis.status === "ready");
          }}
        >
          {actionLabel}
        </button>
      </section>
    );
  }

  if (inAppExplorerId) {
    return (
      <div
        className="log-pane pane--fill log-pane--explorer-embed"
        data-testid="log-pane-in-app-explorer"
        style={{ position: "relative", minHeight: "100%" }}
      >
        <button
          type="button"
          className="btn btn--ghost"
          style={{ position: "absolute", top: 8, right: 8, zIndex: 20 }}
          data-testid="close-in-app-explorer"
          onClick={() => setInAppExplorerId(null)}
        >
          Close Explorer
        </button>
        <LogExplorer corpusId={inAppExplorerId} />
      </div>
    );
  }

  return (
    <div className="log-pane pane--fill" data-testid="log-pane">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Logs</h2>
        <div className="pane-chrome__actions">
          <button
            ref={importLogsTriggerRef}
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void onImportLogs()}
          >
            Import logs…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void onImportPackage()}
          >
            Import package…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !activeId}
            onClick={() => void onExportPackage()}
          >
            Export package…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !activeId || activeEmbedding.state === "complete"}
            data-testid="reanalyze-log-corpus"
            onClick={() => void onReanalyze()}
          >
            Re-analyze locally…
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !activeId}
            data-testid="open-log-explorer"
            onClick={() => {
              if (!activeId) return;
              void hostOpenLogExplorer(activeId)
                .then(() => setNote("Opened Log Explorer window"))
                .catch((e) => {
                  // Escape hatch: full-surface explorer inside Logs (#503)
                  setInAppExplorerId(activeId);
                  setNote(
                    `Multi-window open failed (${String(e)}); opened Explorer in-app.`,
                  );
                });
            }}
          >
            Open Explorer…
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !activeId}
            data-testid="open-log-explorer-in-app"
            title="Open Explorer inside this window (no multi-window)"
            onClick={() => {
              if (!activeId) return;
              setInAppExplorerId(activeId);
              void hostSetActiveLogCorpus(activeId);
            }}
          >
            Open in app
          </button>
          {onOpenHelp ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onOpenHelp("log-explorer")}
            >
              Learn more
            </button>
          ) : null}
        </div>
      </header>

      {ingesting || reanalyzing || progress ? (
        <ProcessProgressPanel
          progress={progress ? hostProgressToWizard(progress) : null}
          kind="log_ingest"
          error={ingesting || reanalyzing ? error : null}
          cancelLabel={reanalyzing ? "Cancel re-analysis" : "Cancel ingest"}
          onCancel={
            ingesting || reanalyzing
              ? () => {
                  const cancel = reanalyzing
                    ? hostCancelLogReanalysis
                    : hostCancelLogIngest;
                  return cancel().then((ok) => {
                    if (ok) setNote("Cancel requested…");
                  });
                }
              : undefined
          }
        />
      ) : null}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {failedIngestDiagnostic ? (
        <section
          className="log-ingest-diagnostic"
          aria-label="Failed import diagnostic"
        >
          <div>
            <strong>Failed import diagnostic available</strong>
            <span>{failedIngestDiagnostic.summary}</span>
            <small>
              No corpus was published. This redacted diagnostic stays only in
              memory until you clear it, start another import, or restart the
              app.
            </small>
          </div>
          <div className="log-ingest-diagnostic__actions">
            <button
              ref={failedDiagnosticTriggerRef}
              type="button"
              className="btn btn--ghost"
              onClick={() => void onOpenFailedIngestDiagnostics()}
            >
              Export diagnostics…
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void clearFailedIngestDiagnostic()}
            >
              Clear diagnostic
            </button>
          </div>
        </section>
      ) : null}
      {note ? <p className="muted log-pane__note">{note}</p> : null}

      <div className="pane__split pane__split--logs">
        <aside
          ref={listRef}
          className="log-list"
          aria-label="Corpora"
          tabIndex={-1}
        >
          {corpora.length === 0 ? (
            <div className="pane-empty">
              <p className="muted">No corpora yet.</p>
              <button type="button" onClick={() => void onImportLogs()}>
                Import logs…
              </button>
            </div>
          ) : (
            <ul className="log-list__items">
              {corpora.map((c) => {
                const red = c.stats?.reductionRatio;
                const size = c.stats?.corpusBytes;
                return (
                  <li key={c.id}>
                    <button
                      ref={(node) => {
                        if (node) corpusButtonRefs.current.set(c.id, node);
                        else corpusButtonRefs.current.delete(c.id);
                      }}
                      type="button"
                      className="log-card"
                      data-active={activeId === c.id ? "true" : "false"}
                      onClick={() => void selectCorpus(c.id)}
                    >
                      <span className="log-card__name">{c.name}</span>
                      <span className="log-card__meta">
                        {c.eventCount.toLocaleString()} events ·{" "}
                        {c.templateCount.toLocaleString()} templates
                        {red != null
                          ? ` · ${formatEventsPerTemplate(red)}`
                          : ""}
                      </span>
                      {size != null ? (
                        <span className="log-card__size">
                          {formatBytes(size)}
                        </span>
                      ) : null}
                    </button>
                    <button
                      ref={(node) => {
                        if (node) menuTriggerRefs.current.set(c.id, node);
                        else menuTriggerRefs.current.delete(c.id);
                      }}
                      type="button"
                      className="log-card__menu-trigger"
                      data-log-corpus-menu-trigger
                      aria-label={`More actions for ${c.name}`}
                      aria-haspopup="menu"
                      aria-expanded={openMenuId === c.id}
                      aria-controls={openMenuId === c.id ? menuId : undefined}
                      disabled={busy}
                      onClick={() => {
                        if (openMenuId === c.id) closeCorpusMenu();
                        else openCorpusMenu(c.id);
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "ArrowDown" ||
                          event.key === "ArrowUp"
                        ) {
                          openCorpusMenu(c.id, event);
                        }
                      }}
                    >
                      <CorpusOverflowGlyph />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="log-detail" aria-label="Corpus detail">
          {!active ? (
            <div className="pane-empty">
              <p className="muted">Select a corpus or import logs to begin.</p>
            </div>
          ) : (
            <>
              <header className="log-detail__header">
                <h3>{active.name}</h3>
                <code className="chip">{active.id.slice(0, 8)}…</code>
                {active.sourceLabel ? (
                  <span className="muted">source: {active.sourceLabel}</span>
                ) : null}
              </header>

              <div className="log-detail__tabs" role="tablist">
                {(
                  [
                    ["overview", "Overview"],
                    ["search", "Search"],
                    ["templates", "Templates"],
                    ["analysis", "Analysis"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    data-active={tab === id ? "true" : "false"}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === "overview" ? (
                <div className="log-detail__body" data-testid="log-overview">
                  {active.stats ? (
                    <>
                      <p className="log-detail__blurb">
                        {statsBlurb(active.stats)}
                      </p>
                      <dl className="log-stat-grid">
                        <div>
                          <dt>Lines</dt>
                          <dd>{active.stats.lines.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Templates</dt>
                          <dd>{active.stats.templates.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Pattern grouping</dt>
                          <dd>
                            {formatEventsPerTemplate(
                              active.stats.reductionRatio,
                            )}{" "}
                            <HelpTip
                              label="Events per template"
                              title="Events per template"
                              content={HELP_TEMPLATE_GROUPING}
                              onOpenHelp={onOpenHelp}
                            />
                          </dd>
                        </div>
                        <div>
                          <dt>Imported files</dt>
                          <dd>{active.stats.files.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Discovered files</dt>
                          <dd>
                            {active.stats.discoveredFiles.toLocaleString()}
                          </dd>
                        </div>
                        <div>
                          <dt>Excluded</dt>
                          <dd>{active.stats.excludedFiles.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Failed</dt>
                          <dd>{active.stats.failedFiles.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Ignored</dt>
                          <dd>{active.stats.ignoredFiles.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Source</dt>
                          <dd>{formatBytes(active.stats.sourceBytes)}</dd>
                        </div>
                        <div>
                          <dt>Corpus</dt>
                          <dd>{formatBytes(active.stats.corpusBytes)}</dd>
                        </div>
                        <div>
                          <dt>Embedded</dt>
                          <dd>{active.stats.embedded.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Analysis mode</dt>
                          <dd data-testid="log-embedding-state">
                            {activeEmbedding.state === "complete"
                              ? "Semantic · complete"
                              : activeEmbedding.state === "partial"
                                ? "Semantic · partial"
                                : activeEmbedding.state === "deferred"
                                  ? "Keyword-only · deferred"
                                  : "Keyword-only"}
                          </dd>
                        </div>
                        <div>
                          <dt>Embedding model</dt>
                          <dd>{activeEmbedding.modelId ?? "None"}</dd>
                        </div>
                      </dl>
                      {active.stats.partial ? (
                        <div
                          className="log-ingest-partial"
                          role="note"
                          data-testid="log-ingest-partial"
                        >
                          <strong>Partial corpus</strong>
                          <span>
                            Some selected content was excluded, ignored, or
                            unreadable.
                          </span>
                          {active.stats.exclusionExamples.length > 0 ? (
                            <ul aria-label="Import exclusions">
                              {active.stats.exclusionExamples.map(
                                (example, index) => (
                                  <li key={`${index}-${example}`}>{example}</li>
                                ),
                              )}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="log-levels">
                        {levelEntries(active.stats.levelCounts).map(
                          ({ level, count }) => (
                            <span
                              key={level}
                              className={`chip chip--level chip--${level}`}
                            >
                              {level} {count}
                            </span>
                          ),
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="muted">
                      {active.eventCount.toLocaleString()} events /{" "}
                      {active.templateCount.toLocaleString()} templates (legacy
                      meta — re-ingest for full stats).
                    </p>
                  )}
                  {active.topTemplates?.length ? (
                    <div>
                      <h4>Top templates</h4>
                      <ul className="log-tops">
                        {active.topTemplates.slice(0, 8).map((t) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              onClick={() => setExemplar(t.pattern)}
                            >
                              n={t.count} sev={t.severity} — {t.pattern}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <p
                    className="muted"
                    role="note"
                    data-testid="log-overview-no-eager-timeline"
                  >
                    The Logs overview no longer loads a decorative volume chart
                    on select (that path burned CPU without seeking or
                    filtering). Use <strong>Open Explorer</strong> for
                    backend-driven time navigation over events.
                  </p>
                </div>
              ) : null}

              {tab === "search" ? (
                <div className="log-detail__body" data-testid="log-search">
                  <p className="muted" role="note">
                    {semanticAvailable
                      ? `Semantic template search is available (${activeEmbedding.embeddedTemplates}/${activeEmbedding.totalTemplates} templates).`
                      : "Keyword search only. Run local re-analysis to enable semantic template search."}
                  </p>
                  <div className="pane__toolbar">
                    <input
                      className="field__control"
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={
                        semanticAvailable
                          ? "paraphrase an error…"
                          : "search exact log terms…"
                      }
                      aria-label="Log search query"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void onSearch();
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onSearch()}
                    >
                      Search
                    </button>
                  </div>
                  <ul className="log-hits">
                    {hits.map((h) => (
                      <li key={h.templateId}>
                        <button
                          type="button"
                          onClick={() =>
                            setExemplar(h.exemplars[0] ?? h.pattern)
                          }
                        >
                          t{h.templateId} score={h.score.toFixed(2)} —{" "}
                          {h.pattern}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {tab === "templates" ? (
                <div
                  className="log-detail__body"
                  data-testid="log-templates"
                  aria-busy={activeAnalysis.status === "loading"}
                >
                  {renderAnalysisLoadControl()}
                  {activeAnalysis.status === "ready" ||
                  activeAnalysis.templates.length > 0 ? (
                    activeAnalysis.templates.length > 0 ? (
                      <table className="log-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Count</th>
                            <th>Sev</th>
                            <th>Pattern</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeAnalysis.templates.map((template) => (
                            <tr key={template.id}>
                              <td>{template.id}</td>
                              <td>{template.count}</td>
                              <td>{template.severity}</td>
                              <td>
                                <button
                                  type="button"
                                  onClick={() => setExemplar(template.pattern)}
                                >
                                  {template.pattern}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="muted">No templates were returned.</p>
                    )
                  ) : null}
                </div>
              ) : null}

              {tab === "analysis" ? (
                <div
                  className="log-detail__body"
                  data-testid="log-analysis"
                  aria-busy={activeAnalysis.status === "loading"}
                >
                  {renderAnalysisLoadControl()}
                  <h4>Problem clusters</h4>
                  {activeAnalysis.status === "ready" ||
                  activeAnalysis.clusters.length > 0 ? (
                    activeAnalysis.clusters.length > 0 ? (
                      <ul className="log-clusters">
                        {activeAnalysis.clusters.map((cluster) => (
                          <li key={cluster.clusterId}>
                            <button
                              type="button"
                              onClick={() =>
                                setExemplar(
                                  cluster.exemplars[0] ?? cluster.label,
                                )
                              }
                            >
                              sev={cluster.severity} n={cluster.count} score=
                              {cluster.score.toFixed(1)} — {cluster.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">No clusters.</p>
                    )
                  ) : null}
                  <p className="muted">
                    Deeper correlate / anomalies / trace are available via the
                    log-triage agent tools in chat.
                  </p>
                </div>
              ) : null}

              {exemplar ? (
                <section className="log-exemplar" aria-label="Exemplar">
                  <h4>Exemplar</h4>
                  <pre>{exemplar}</pre>
                </section>
              ) : null}
            </>
          )}
        </section>
      </div>
      {diagnostic ? (
        <LogDiagnosticDialog
          corpus={diagnostic.corpus}
          failedIngest={diagnostic.failedIngest}
          environment={diagnostic.environment}
          currentStatus={diagnostic.currentStatus}
          onDismiss={closeDiagnostics}
        />
      ) : null}
      {openMenuId && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="log-card__menu"
              role="menu"
              aria-label={`Actions for ${
                corpora.find((corpus) => corpus.id === openMenuId)?.name ??
                "corpus"
              }`}
              style={
                menuPosition
                  ? { left: menuPosition.left, top: menuPosition.top }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
            >
              <button
                type="button"
                role="menuitem"
                className="log-card__menu-item"
                onKeyDown={onMenuItemKeyDown}
                onClick={() => void onOpenDiagnostics(openMenuId)}
              >
                Export diagnostics…
              </button>
              <button
                type="button"
                role="menuitem"
                className="log-card__menu-item log-card__menu-item--danger"
                onKeyDown={onMenuItemKeyDown}
                onClick={() => void onDiscard(openMenuId)}
              >
                Discard corpus…
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
