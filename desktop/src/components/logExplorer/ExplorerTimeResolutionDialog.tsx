import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  hostApplyLogSourceTimezone,
  hostClearLogSourceTimezone,
  hostLoadLogTimezoneState,
  hostPreviewLogSourceTimezone,
  type LogTimezoneApplyRequestDto,
  type LogTimezoneClearRequestDto,
  type LogTimezoneStateDto,
} from "../../lib/host";
import { broadcastTimeRevisionChanged } from "../../lib/logExplorer/timeRevisionBridge";
import { LogTimezoneStatus } from "../panes/LogTimezoneStatus";

type Props = {
  corpusId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
};

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  );
}

export function ExplorerTimeResolutionDialog({
  corpusId,
  triggerRef,
  onDismiss,
}: Props) {
  const [state, setState] = useState<LogTimezoneStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const restoreFocus = useCallback(() => {
    queueMicrotask(() => triggerRef.current?.focus());
  }, [triggerRef]);

  const dismiss = useCallback(() => {
    onDismiss();
    restoreFocus();
  }, [onDismiss, restoreFocus]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await hostLoadLogTimezoneState(corpusId));
    } catch (loadError) {
      setState(null);
      setError(`Time interpretation is unavailable: ${String(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, [corpusId]);

  useEffect(() => {
    void refresh();
    queueMicrotask(() => closeRef.current?.focus());
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  const apply = async (request: LogTimezoneApplyRequestDto) => {
    await hostApplyLogSourceTimezone(request);
    const [next] = await Promise.all([
      hostLoadLogTimezoneState(corpusId),
      broadcastTimeRevisionChanged(request.corpusId),
    ]);
    setState(next);
  };

  const clear = async (request: LogTimezoneClearRequestDto) => {
    await hostClearLogSourceTimezone(request);
    const [next] = await Promise.all([
      hostLoadLogTimezoneState(corpusId),
      broadcastTimeRevisionChanged(request.corpusId),
    ]);
    setState(next);
  };

  const dialog = (
    <div
      className="log-explorer-time-resolution__backdrop"
      data-testid="explorer-time-resolution-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={panelRef}
        className="log-explorer-time-resolution"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = focusableElements(panelRef.current);
          if (focusable.length === 0) return;
          const first = focusable[0]!;
          const last = focusable.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="log-explorer-time-resolution__header">
          <div>
            <span className="eyebrow">Investigation time</span>
            <h2 id={titleId}>Resolve timestamp ambiguity</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost"
            onClick={dismiss}
          >
            Close
          </button>
        </header>
        <p id={descriptionId} className="log-explorer-time-resolution__lead">
          Original timestamp text stays unchanged. Review a source timezone to
          place compatible local timestamps on the shared timeline, or leave
          them order-only and decide later.
        </p>
        {loading ? (
          <p role="status">Loading time interpretation…</p>
        ) : error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : state ? (
          <LogTimezoneStatus
            state={state}
            onPreview={hostPreviewLogSourceTimezone}
            onApply={apply}
            onClear={clear}
          />
        ) : null}
        {!loading &&
        !error &&
        state &&
        state.sources.every(
          (source) =>
            source.unresolvedLocalRecords === 0 &&
            !Object.hasOwn(state.declarations, source.source),
        ) ? (
          <p role="status">
            This corpus has no retained local timestamp that can be resolved by
            a timezone declaration. Missing or malformed source time remains
            sequence-ordered.
          </p>
        ) : null}
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
