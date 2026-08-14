/**
 * Curated provider/model visibility management (#678).
 *
 * Ordinary Settings shows only a one-line count; the inventory itself lives
 * behind an explicit "Manage…" so a gateway with thousands of models never
 * dumps into the page. Inside, the list is searchable and fully keyboard
 * operable.
 *
 * Hiding here is display curation. It never deletes a provider profile, a
 * credential reference, a locally installed model, or anything remote, and it
 * is never a security or redaction claim — the panel says so out loud.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  getCurationSummary,
  listChatModels,
  previewCurationChange,
  setModelHidden,
  setModelPinned,
  setProviderHidden,
  type CurationImpactDto,
  type CurationSummaryDto,
  type ModelOptionDto,
} from "../../lib/engine/modelCuration";
import { curateModels } from "../../lib/modelCuration";
import { modelReadinessLabel } from "../../lib/modelReadiness";
import { nextRovingIndex } from "../../lib/a11y";

/** A change awaiting the user's explicit acceptance of a new default. */
type PendingChange = {
  kind: "model" | "provider";
  providerId: string;
  modelId?: string;
  hidden: boolean;
  label: string;
  impact: CurationImpactDto;
};

type ChangeOrigin = {
  element: HTMLButtonElement;
  selectionKey: string;
  rowIndex: number;
};

type FocusRepair = Pick<ChangeOrigin, "selectionKey" | "rowIndex">;

type Props = {
  /**
   * Called after any committed curation change so the app re-lists its model
   * pickers. Without it, hiding a model has no visible effect in the main
   * window until the next AI-setup save or app restart (#678).
   */
  onCurationChanged?: () => void | Promise<void>;
};

export function ModelVisibilityPanel({ onCurationChanged }: Props = {}) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOptionDto[]>([]);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [summary, setSummary] = useState<CurationSummaryDto | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusRepair, setFocusRepair] = useState<FocusRepair | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingCancelRef = useRef<HTMLButtonElement>(null);
  const changeOriginRef = useRef<ChangeOrigin | null>(null);
  /** Discards responses from a superseded reload. */
  const loadTicketRef = useRef(0);

  const reload = useCallback(async () => {
    const ticket = (loadTicketRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      // The management surface is the one caller that asks for everything.
      const all = await listChatModels({ includeHidden: true });
      if (loadTicketRef.current !== ticket) return;
      setModels(all);
      setError(null);
    } catch (e) {
      if (loadTicketRef.current !== ticket) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (loadTicketRef.current === ticket) setLoading(false);
    }
  }, []);

  /**
   * Ordinary Settings loads counts only. Listing models means discovery
   * against every configured provider, and the AC is explicit that the hidden
   * inventory must not be loaded by default — so that waits for Manage.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const counts = await getCurationSummary();
        if (!cancelled) setSummary(counts);
      } catch {
        /* the summary is informational; failures surface on open */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const view = useMemo(
    () => curateModels(models, { query, includeHidden: showHidden }),
    [models, query, showHidden],
  );

  /** Flat row order, matching what the list renders, for arrow navigation. */
  const rows = useMemo(
    () => [...view.pinned, ...view.available, ...view.hidden],
    [view],
  );

  useEffect(() => {
    if (activeIndex > rows.length - 1) setActiveIndex(Math.max(0, rows.length - 1));
  }, [rows.length, activeIndex]);

  const focusRow = useCallback((index: number) => {
    setActiveIndex(index);
    window.requestAnimationFrame(() => {
      const el = listRef.current?.querySelectorAll<HTMLElement>(
        "[data-model-row]",
      )[index];
      el?.focus();
    });
  }, []);

  // A committed hide can remove the focused row. Prefer the same model when
  // it remains listed (for example with Show hidden enabled); otherwise move
  // to the row that took its place, or back to search if the list is empty.
  useEffect(() => {
    if (!focusRepair || loading) return;
    const sameRow = rows.findIndex(
      (m) => m.selection_key === focusRepair.selectionKey,
    );
    const nextIndex =
      sameRow >= 0
        ? sameRow
        : Math.min(focusRepair.rowIndex, rows.length - 1);
    setFocusRepair(null);
    if (nextIndex >= 0) focusRow(nextIndex);
    else window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [focusRepair, focusRow, loading, rows]);

  const runChange = useCallback(
    async (
      change: Omit<PendingChange, "impact">,
      accept?: string,
      expectedStateToken?: string,
    ) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const impact =
          change.kind === "model"
            ? await setModelHidden({
                providerId: change.providerId,
                modelId: change.modelId!,
                hidden: change.hidden,
                acceptReplacement: accept ?? null,
                expectedStateToken: expectedStateToken ?? null,
              })
            : await setProviderHidden({
                providerId: change.providerId,
                hidden: change.hidden,
                acceptReplacement: accept ?? null,
                expectedStateToken: expectedStateToken ?? null,
              });
        setPending(null);
        await reload();
        const origin = changeOriginRef.current;
        changeOriginRef.current = null;
        if (origin) {
          setFocusRepair({
            selectionKey: origin.selectionKey,
            rowIndex: origin.rowIndex,
          });
        }
        setSummary(await getCurationSummary());
        await onCurationChanged?.();
        setNote(
          change.hidden
            ? `${change.label} is hidden from ordinary pickers. Nothing was deleted.`
            : `${change.label} is available again.`,
        );
        return impact;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reload, onCurationChanged],
  );

  /** Ask the host what a change would do before writing anything. */
  const requestChange = useCallback(
    async (
      change: Omit<PendingChange, "impact">,
      origin: ChangeOrigin,
    ) => {
      changeOriginRef.current = origin;
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const impact = await previewCurationChange({
          providerId: change.providerId,
          modelId: change.modelId ?? null,
          hidden: change.hidden,
        });
        if (!impact) {
          changeOriginRef.current = null;
          setError("Model visibility is only available in the desktop app.");
          return;
        }
        if (impact.remaining_visible === 0) {
          changeOriginRef.current = null;
          setError(
            "At least one model must stay visible — restore another choice first.",
          );
          return;
        }
        if (impact.affects_default && !impact.replacement_key) {
          setError(
            "No discovered replacement default is available — verify another provider in AI settings first.",
          );
          return;
        }
        if (impact.affects_default) {
          // Never silently invalidate: name the exact replacement and wait.
          setPending({ ...change, impact });
          return;
        }
        setBusy(false);
        await runChange(change, undefined, impact.state_token);
      } catch (e) {
        changeOriginRef.current = null;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [runChange],
  );

  const togglePin = async (m: ModelOptionDto) => {
    setBusy(true);
    setError(null);
    try {
      await setModelPinned({
        providerId: m.provider_id,
        modelId: m.id,
        pinned: typeof m.pinned_rank !== "number",
      });
      await reload();
      setSummary(await getCurationSummary());
      await onCurationChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const closePanel = useCallback(() => {
    setOpen(false);
    setPending(null);
    setNote(null);
    changeOriginRef.current = null;
    setFocusRepair(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const cancelPending = useCallback(() => {
    const origin = changeOriginRef.current;
    changeOriginRef.current = null;
    setPending(null);
    setNote("No change was made.");
    window.requestAnimationFrame(() => {
      if (origin?.element.isConnected) origin.element.focus();
      else searchRef.current?.focus();
    });
  }, []);

  // Escape closes, and opening moves focus into the panel rather than leaving
  // it on a trigger that is no longer rendered.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // A pending confirmation is the topmost decision; cancel that first.
      if (pending) {
        cancelPending();
        return;
      }
      closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, cancelPending, closePanel]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!pending) return;
    window.requestAnimationFrame(() => pendingCancelRef.current?.focus());
  }, [pending]);

  const summaryText = summary
    ? [
        summary.hidden_models > 0 ? `${summary.hidden_models} hidden` : null,
        summary.hidden_providers > 0
          ? `${summary.hidden_providers} provider${summary.hidden_providers === 1 ? "" : "s"} hidden`
          : null,
        summary.pinned_models > 0 ? `${summary.pinned_models} pinned` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "Nothing hidden"
    : "…";
  const dialogId = `${baseId}-visibility`;

  if (!open) {
    return (
      <div className="model-visibility">
        <div className="model-visibility__summary">
          <span className="field__label">Model visibility</span>
          <span className="field__hint" data-testid="curation-summary">
            {summaryText}
          </span>
        </div>
        <button
          type="button"
          ref={triggerRef}
          className="btn btn--ghost btn--sm"
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(true);
            void reload();
          }}
        >
          Manage…
        </button>
      </div>
    );
  }

  return (
    <div
      className="settings-connector-block model-visibility__panel"
      role="dialog"
      aria-labelledby={`${dialogId}-title`}
      aria-describedby={`${dialogId}-note`}
      aria-busy={loading || busy}
    >
      <h3 className="settings-connector-block__title" id={`${dialogId}-title`}>
        Model visibility
      </h3>
      <p className="field__hint" id={`${dialogId}-note`}>
        Choose what ordinary pickers offer. Hiding is a display preference: it
        never deletes a provider, a credential, a local model, or anything
        remote, and it is not a privacy or security control.
      </p>

      <div className="model-visibility__controls">
        <label className="field model-visibility__search" htmlFor={`${dialogId}-search`}>
          <span className="field__label">Search models</span>
          <input
            id={`${dialogId}-search`}
            ref={searchRef}
            className="field__control"
            type="search"
            value={query}
            placeholder="Filter by model or provider…"
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
          />
        </label>
        <label className="pane__toolbar-toggle">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden ({view.hiddenCount})
        </label>
      </div>

      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="field__hint" role="status">
          {note}
        </p>
      ) : null}

      {pending ? (
        <div className="callout callout--warn" role="alert">
          <strong>This changes the default for new chats.</strong>{" "}
          {pending.impact.replacement_label ? (
            <>
              {pending.hidden ? "Hiding" : "Restoring"} {pending.label} will
              make <strong>{pending.impact.replacement_label}</strong> the
              default.
            </>
          ) : (
            <>
              {pending.hidden ? "Hiding" : "Restoring"} {pending.label} leaves
              no default available.
            </>
          )}
          <div className="workspace-root-actions">
            <button
              type="button"
              ref={pendingCancelRef}
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={cancelPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy || !pending.impact.replacement_key}
              onClick={() =>
                void runChange(
                  pending,
                  pending.impact.replacement_key ?? undefined,
                  pending.impact.state_token,
                )
              }
            >
              {pending.hidden ? "Hide" : "Restore"} and use that default
            </button>
          </div>
        </div>
      ) : null}

      {loading && models.length === 0 ? (
        <p className="field__hint" role="status">
          Loading models…
        </p>
      ) : error && models.length === 0 ? null : view.empty ? (
        <p className="field__hint" role="status">
          {query
            ? "No models match that search."
            : "No models are listed. Check the provider settings above."}
        </p>
      ) : (
        <ul
          className="model-visibility__list"
          ref={listRef}
          aria-label="Discovered models"
          onKeyDown={(e) => {
            const next = nextRovingIndex(activeIndex, rows.length, e.key);
            if (next == null) return;
            e.preventDefault();
            focusRow(next);
          }}
        >
          {rows.map((m, index) => {
            const pinned = typeof m.pinned_rank === "number";
            return (
              <li key={m.selection_key} className="model-visibility__row">
                <div
                  data-model-row
                  tabIndex={index === activeIndex ? 0 : -1}
                  className="model-visibility__row-main"
                  data-hidden={m.hidden ? "true" : undefined}
                >
                  <span className="model-visibility__name">{m.label}</span>
                  <span className="field__hint">
                    {m.provider_label}
                    {m.is_default ? " · default" : ""}
                    {pinned ? " · pinned" : ""}
                    {` · ${modelReadinessLabel(m)}`}
                    {m.hidden
                      ? m.hidden_by === "provider"
                        ? " · hidden with its provider"
                        : " · hidden"
                      : ""}
                    {!m.tools_enabled ? " · tools unavailable" : ""}
                    {m.availability === "configured_unverified"
                      ? " · availability unverified"
                      : ""}
                  </span>
                  {m.availability_detail ? (
                    <span className="field__hint">{m.availability_detail}</span>
                  ) : null}
                  {m.readiness?.detail ? (
                    <span className="field__hint">{m.readiness.detail}</span>
                  ) : null}
                </div>
                {/*
                  Roving tabindex: the action buttons follow their row out of
                  the tab order, so Tab moves past the list instead of through
                  three buttons per row. Arrows move between rows; the row's
                  own actions are reached by Tab once that row is active.
                */}
                <div className="model-visibility__row-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    tabIndex={index === activeIndex ? 0 : -1}
                    disabled={busy || m.hidden || pending !== null}
                    aria-pressed={pinned}
                    aria-label={`${pinned ? "Unpin" : "Pin"} ${m.label} from ${m.provider_label}`}
                    title={
                      m.hidden
                        ? "Restore this model before pinning it"
                        : "Pin to the top of every picker"
                    }
                    onClick={() => void togglePin(m)}
                  >
                    {pinned ? "Unpin" : "Pin"}
                  </button>
                  {/*
                    While the provider governs this model there is no coherent
                    per-model toggle to offer: its own setting is preserved
                    underneath and reapplies when the provider is restored.
                    Showing a disabled "Restore" there would misdescribe both.
                  */}
                  {m.hidden_by === "provider" ? null : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      tabIndex={index === activeIndex ? 0 : -1}
                      disabled={busy || pending !== null}
                      aria-label={`${m.hidden ? "Restore" : "Hide"} ${m.label} from ${m.provider_label}`}
                      onClick={(event) =>
                        void requestChange(
                          {
                            kind: "model",
                            providerId: m.provider_id,
                            modelId: m.id,
                            hidden: !m.hidden,
                            label: `${m.provider_label} · ${m.label}`,
                          },
                          {
                            element: event.currentTarget,
                            selectionKey: m.selection_key,
                            rowIndex: index,
                          },
                        )
                      }
                    >
                      {m.hidden ? "Restore" : "Hide"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    tabIndex={index === activeIndex ? 0 : -1}
                    disabled={busy || pending !== null}
                    aria-label={`${m.hidden_by === "provider" ? "Restore" : "Hide"} provider ${m.provider_label}`}
                    title="Hide or restore every model from this provider"
                    onClick={(event) =>
                      void requestChange(
                        {
                          kind: "provider",
                          providerId: m.provider_id,
                          hidden: m.hidden_by !== "provider",
                          label: m.provider_label,
                        },
                        {
                          element: event.currentTarget,
                          selectionKey: m.selection_key,
                          rowIndex: index,
                        },
                      )
                    }
                  >
                    {m.hidden_by === "provider"
                      ? "Restore provider"
                      : "Hide provider"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {view.truncated > 0 ? (
        <p className="field__hint" role="status">
          Showing the first {rows.length}. {view.truncated} more match — narrow
          the search to reach them.
        </p>
      ) : null}

      <div className="workspace-root-actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={closePanel}
        >
          Done
        </button>
      </div>
    </div>
  );
}
