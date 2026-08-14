import { useEffect, useState } from "react";
import {
  applyPreset,
  classifyPreset,
  deadlinePolicyHint,
  formatDeadlineMs,
  parseDeadlineDuration,
  type DeadlinePreset,
} from "../../lib/deadlineControls";
import {
  effortPolicyHint,
  levelFromDto,
  levelToSavePayload,
  REASONING_EFFORT_OPTIONS,
  type ReasoningEffortLevel,
} from "../../lib/reasoningEffort";
import {
  hostCheckForUpdates,
  hostGetAmbientRecallEnabled,
  hostGetBranding,
  hostGetHybridRetrieval,
  hostGetReasoningEffort,
  hostInstallUpdate,
  hostSetAmbientRecallEnabled,
  hostSetHybridRetrieval,
  hostSetReasoningEffort,
  hostSourceGitFetch,
  hostSourceGitStatus,
  type BrandingDto,
  type RouterBudgetDto,
  type SourceGitStatusDto,
} from "../../lib/host";
import type { AppSetupState } from "../../lib/preflight";
import { SelectField, TextField } from "../forms";

export type GeneralSectionProps = {
  baseId: string;
  draft: AppSetupState;
  routerBudget: RouterBudgetDto;
  setRouterBudget: React.Dispatch<React.SetStateAction<RouterBudgetDto>>;
};

export function GeneralSection({
  baseId,
  draft,
  routerBudget,
  setRouterBudget,
}: GeneralSectionProps) {
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [hybridOn, setHybridOn] = useState(false);
  const [hybridNote, setHybridNote] = useState<string | null>(null);
  const [ambientOn, setAmbientOn] = useState(true);
  const [ambientNote, setAmbientNote] = useState<string | null>(null);
  const [identity, setIdentity] = useState<BrandingDto | null>(null);
  const [pollEnabled, setPollEnabled] = useState(false);
  const [pollHours, setPollHours] = useState(24);
  const [gitStatus, setGitStatus] = useState<SourceGitStatusDto | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitNote, setGitNote] = useState<string | null>(null);

  useEffect(() => {
    void hostGetHybridRetrieval().then((v) => {
      if (v !== null) setHybridOn(v);
    });
    void hostGetAmbientRecallEnabled().then((v) => {
      if (v !== null) setAmbientOn(v);
    });
    void hostGetBranding().then((b) => setIdentity(b));
    void import("../../lib/updatePoll").then(({ loadUpdatePollPrefs }) => {
      const p = loadUpdatePollPrefs();
      setPollEnabled(p.enabled);
      setPollHours(p.intervalHours);
    });
    void hostSourceGitStatus().then((s) => setGitStatus(s));
  }, []);

  const onCheckUpdates = async () => {
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      const result = await hostCheckForUpdates();
      if (!result.available) {
        setUpdateNote(
          result.currentVersion === "browser"
            ? "Updates require the desktop app (Tauri)."
            : `You're on ${result.currentVersion}. No update found.`,
        );
        return;
      }
      const { dialogConfirm } = await import("../../lib/dialogs");
      const ok = await dialogConfirm(
        `Version ${result.version} is available (you have ${result.currentVersion}). Download and install now? The app will restart after install.`,
        { title: "Update available", kind: "info" },
      );
      if (!ok) {
        setUpdateNote(`Update ${result.version} available — install cancelled.`);
        return;
      }
      setUpdateNote(`Downloading ${result.version}…`);
      await hostInstallUpdate();
      setUpdateNote("Update installed. Restart if the app did not relaunch.");
    } catch (e) {
      setUpdateNote(
        e instanceof Error ? e.message : "Could not check for updates",
      );
    } finally {
      setUpdateBusy(false);
    }
  };

  return (
    <div>
      <p className="section-lead">
        ContextDesk is configured through this UI. Config on disk is an
        implementation detail — not the workflow.
      </p>
      <p className="section-lead">
        Data directory status:{" "}
        {draft.dataDirWritable ? "writable" : "not writable"}.
      </p>
      <h3 className="settings-connector-block__title">About / build identity</h3>
      <p className="field__hint" data-testid="build-identity-line">
        {identity?.identity_line ??
          (identity
            ? `v${identity.version} · channel=${identity.channel} · protocol=${identity.protocol}${
                identity.git_sha ? ` · git=${identity.git_sha}` : ""
              }`
            : "Loading identity…")}
      </p>
      {identity?.channel === "dev" ? (
        <p className="field__hint">
          Channel <code>dev</code> is for source/debug runs — signed installer
          auto-update does not apply. Packaged builds set{" "}
          <code>CD_CHANNEL=installed</code>.
        </p>
      ) : null}
      <h3 className="settings-connector-block__title">Updates</h3>
      <p className="field__hint">
        Opt-in signed channel (#173 / #339). Nothing installs without
        confirmation. Background poll is off by default; only applies when
        channel is <code>installed</code> (source/dev builds skip installer
        updates).
      </p>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={pollEnabled}
          onChange={(e) => {
            const enabled = e.target.checked;
            setPollEnabled(enabled);
            void import("../../lib/updatePoll").then(
              ({ loadUpdatePollPrefs, saveUpdatePollPrefs }) => {
                const cur = loadUpdatePollPrefs();
                saveUpdatePollPrefs({
                  ...cur,
                  enabled,
                  intervalHours: pollHours,
                });
              },
            );
          }}
        />
        <span>Background update checks (opt-in)</span>
      </label>
      <label className="field__label" htmlFor={`${baseId}-poll-hours`}>
        Check interval (hours)
      </label>
      <input
        id={`${baseId}-poll-hours`}
        className="field__control"
        type="number"
        min={1}
        max={168}
        value={pollHours}
        disabled={!pollEnabled}
        onChange={(e) => {
          const intervalHours = Math.max(
            1,
            Math.min(168, Number(e.target.value) || 24),
          );
          setPollHours(intervalHours);
          void import("../../lib/updatePoll").then(
            ({ loadUpdatePollPrefs, saveUpdatePollPrefs }) => {
              const cur = loadUpdatePollPrefs();
              saveUpdatePollPrefs({ ...cur, intervalHours });
            },
          );
        }}
      />
      <div className="workspace-root-actions">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={updateBusy}
          onClick={() => void onCheckUpdates()}
        >
          {updateBusy ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {updateNote ? <p className="field__hint">{updateNote}</p> : null}

      <h3 className="settings-connector-block__title">
        Source-run update (git checkout)
      </h3>
      <p className="field__hint" data-testid="source-git-update">
        For developers running from a clone — <strong>not</strong> the signed
        installer updater above. Never hard-resets a dirty tree; fetch is
        explicit only.
      </p>
      {gitStatus ? (
        <p className="field__hint" role="status">
          {gitStatus.summary}
        </p>
      ) : (
        <p className="field__hint">Git status unavailable outside Tauri.</p>
      )}
      {gitStatus?.isGitRepo && gitStatus.fetchAllowed ? (
        <>
          {gitStatus.path ? (
            <p className="field__hint">
              Checkout: <code>{gitStatus.path}</code>
              {gitStatus.remoteUrl ? (
                <>
                  {" "}
                  · remote <code>{gitStatus.remoteUrl}</code>
                </>
              ) : null}
            </p>
          ) : null}
          <pre className="tool-row__detail">{gitStatus.rebuildHint}</pre>
          <div className="workspace-root-actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={gitBusy || !gitStatus.fetchAllowed}
              title="Fetches only the product upstream remote (not --all)"
              onClick={() => {
                setGitBusy(true);
                setGitNote(null);
                void hostSourceGitFetch()
                  .then((s) => {
                    setGitStatus(s);
                    setGitNote(
                      `Fetched ${s.remote ?? "origin"} only. Review ahead/behind above.`,
                    );
                  })
                  .catch((e) => {
                    setGitNote(
                      e instanceof Error ? e.message : "git fetch failed",
                    );
                  })
                  .finally(() => setGitBusy(false));
              }}
            >
              {gitBusy ? "Fetching…" : "Fetch upstream"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={gitBusy}
              onClick={() => {
                void hostSourceGitStatus().then((s) => setGitStatus(s));
              }}
            >
              Refresh status
            </button>
          </div>
          {gitStatus.dirty ? (
            <div className="callout callout--warn" role="status">
              Working tree is dirty — stash or commit before <code>git pull</code>
              . This UI will not hard-reset.
            </div>
          ) : null}
        </>
      ) : gitStatus && !gitStatus.fetchAllowed ? (
        <p className="field__hint" role="status">
          Fetch disabled — not a proven ContextDesk product source checkout
          (active workspace roots are never used for this operation).
        </p>
      ) : null}
      {gitNote ? <p className="field__hint">{gitNote}</p> : null}

      <h3 className="settings-connector-block__title">Hybrid retrieval</h3>
      <p className="field__hint">
        Opt-in hybrid scoring for <code>search_kb</code> (keyword + recency +
        optional local embeddings). Default off keeps pure keyword search.
        When on and the active provider is Ollama, local embeddings are used
        when available (#119).
      </p>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={hybridOn}
          onChange={(e) => {
            const next = e.target.checked;
            setHybridOn(next);
            void hostSetHybridRetrieval(next)
              .then((v) => {
                setHybridOn(v);
                setHybridNote(
                  v
                    ? "Hybrid retrieval on — search_kb uses hybrid scoring."
                    : "Hybrid retrieval off — keyword-only search_kb.",
                );
              })
              .catch((err) =>
                setHybridNote(
                  err instanceof Error ? err.message : "Could not save hybrid setting",
                ),
              );
          }}
        />
        <span>Enable hybrid retrieval (search_kb)</span>
      </label>
      {hybridNote ? <p className="field__hint">{hybridNote}</p> : null}
      <h3 className="settings-connector-block__title">Ambient memory recall</h3>
      <p className="field__hint">
        When on, each chat turn injects a tight set of durable memories (≤~1,500
        chars, ≤5 hits, min score ~0.35) so the agent &quot;just knows&quot;
        without an explicit <code>recall_memory</code> call. Secrets are
        redacted at write time. Default <strong>on</strong> (MEMORY.md §10.1 /
        #271). Explicit <code>recall_memory</code> always works either way.
      </p>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={ambientOn}
          onChange={(e) => {
            const next = e.target.checked;
            setAmbientOn(next);
            void hostSetAmbientRecallEnabled(next)
              .then((v) => {
                setAmbientOn(v);
                setAmbientNote(
                  v
                    ? "Ambient recall on — memories may inject each turn."
                    : "Ambient recall off — only explicit recall_memory fetches memory.",
                );
              })
              .catch((err) =>
                setAmbientNote(
                  err instanceof Error
                    ? err.message
                    : "Could not save ambient recall setting",
                ),
              );
          }}
        />
        <span>Enable ambient memory recall</span>
      </label>
      {ambientNote ? <p className="field__hint">{ambientNote}</p> : null}
      <h3 className="settings-connector-block__title">Retrieval budgets</h3>
      <p className="field__hint">
        Enforced on the agent loop and search_kb. Reflected in the search trail
        as{" "}
        <code>budget:sources=…,rounds=…,per_source=…,deadline=…ms</code>.
      </p>
      <TextField
        id={`${baseId}-rounds`}
        label="Max tool rounds"
        hint="1–32. Loop stops with reason budget_rounds."
        value={String(routerBudget.max_tool_rounds)}
        onChange={(e) =>
          setRouterBudget((b) => ({
            ...b,
            max_tool_rounds: Number(e.target.value) || 1,
          }))
        }
      />
      <TextField
        id={`${baseId}-per-source`}
        label="Max results per source"
        hint="Caps search_kb limit (smaller of tool arg and this)."
        value={String(routerBudget.max_results_per_source)}
        onChange={(e) =>
          setRouterBudget((b) => ({
            ...b,
            max_results_per_source: Number(e.target.value) || 1,
          }))
        }
      />
      <TextField
        id={`${baseId}-sources`}
        label="Max ranked sources"
        hint="How many sources rank_sources may fan out."
        value={String(routerBudget.max_sources)}
        onChange={(e) =>
          setRouterBudget((b) => ({
            ...b,
            max_sources: Number(e.target.value) || 1,
          }))
        }
      />
      <ReasoningEffortControls baseId={baseId} />
      <DeadlineControls
        baseId={baseId}
        routerBudget={routerBudget}
        setRouterBudget={setRouterBudget}
      />
    </div>
  );
}

/**
 * Reasoning-effort control: omit (provider default) or an explicit level.
 * Affects cost/latency only — not a readiness badge.
 */
export function ReasoningEffortControls({ baseId }: { baseId: string }) {
  const [level, setLevel] = useState<ReasoningEffortLevel>("omit");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dto = await hostGetReasoningEffort();
        if (cancelled || !dto) return;
        setLevel(levelFromDto(dto.policy, dto.level));
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = async (next: ReasoningEffortLevel) => {
    const previous = level;
    setLevel(next);
    setError(null);
    setNote(null);
    try {
      const saved = await hostSetReasoningEffort(levelToSavePayload(next));
      setLevel(levelFromDto(saved.policy, saved.level));
      setNote(
        next === "omit"
          ? "Saved: provider default (no effort field)."
          : `Saved: explicit effort “${next}”.`,
      );
    } catch (e) {
      setLevel(previous);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="reasoning-effort-controls">
      <SelectField
        id={`${baseId}-reasoning-effort`}
        label="Reasoning effort"
        hint={effortPolicyHint(level)}
        value={level}
        onChange={(event) =>
          void onChange(event.target.value as ReasoningEffortLevel)
        }
        aria-describedby={
          error ? `${baseId}-reasoning-effort-error` : undefined
        }
      >
        {REASONING_EFFORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </SelectField>
      {error ? (
        <p
          id={`${baseId}-reasoning-effort-error`}
          className="field__error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {note && !error ? <p className="field__hint">{note}</p> : null}
    </div>
  );
}

/**
 * Whole-turn deadline control: Auto / Standard / Patient / Custom.
 * Never requires users to enter raw milliseconds. Invalid custom input is
 * shown inline and does not update the last valid budget (so Save cannot
 * persist garbage).
 */
export function DeadlineControls({
  baseId,
  routerBudget,
  setRouterBudget,
}: {
  baseId: string;
  routerBudget: RouterBudgetDto;
  setRouterBudget: React.Dispatch<React.SetStateAction<RouterBudgetDto>>;
}) {
  // Local mode so choosing Custom and typing `3m` does not snap back to
  // Standard just because the numeric value matches a fixed preset.
  const [preset, setPreset] = useState<DeadlinePreset>(() =>
    classifyPreset(routerBudget),
  );
  const [customDraft, setCustomDraft] = useState(() =>
    formatDeadlineMs(routerBudget.deadline_ms),
  );
  const [customError, setCustomError] = useState<string | null>(null);

  // Re-derive from host budget when not mid-custom edit.
  useEffect(() => {
    const derived = classifyPreset(routerBudget);
    setPreset((prev) =>
      prev === "custom" && routerBudget.deadline_is_explicit ? "custom" : derived,
    );
    if (!(preset === "custom" && routerBudget.deadline_is_explicit)) {
      setCustomDraft(formatDeadlineMs(routerBudget.deadline_ms));
      setCustomError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to host budget fields
  }, [routerBudget.deadline_ms, routerBudget.deadline_is_explicit]);

  const onPresetChange = (next: DeadlinePreset) => {
    const customParsed =
      next === "custom" ? parseDeadlineDuration(customDraft) : null;
    setPreset(next);
    setRouterBudget((budget) => {
      const fields = applyPreset(
        {
          deadline_ms: budget.deadline_ms,
          deadline_is_explicit: budget.deadline_is_explicit,
        },
        next,
        customParsed?.ok ? customParsed.ms : undefined,
      );
      return { ...budget, ...fields };
    });
    if (next === "custom") {
      setCustomError(customParsed && !customParsed.ok ? customParsed.error : null);
    } else {
      setCustomError(null);
      if (next === "standard" || next === "patient") {
        setCustomDraft(
          formatDeadlineMs(
            next === "standard" ? 180_000 : 300_000,
          ),
        );
      }
    }
  };

  const onCustomChange = (value: string) => {
    setCustomDraft(value);
    const parsed = parseDeadlineDuration(value);
    if (!parsed.ok) {
      setCustomError(parsed.error);
      return;
    }
    setCustomError(null);
    setRouterBudget((budget) => ({
      ...budget,
      deadline_ms: parsed.ms,
      deadline_is_explicit: true,
    }));
  };

  return (
    <div className="deadline-controls">
      <SelectField
        id={`${baseId}-deadline-policy`}
        label="Whole-turn time limit"
        hint={deadlinePolicyHint(preset)}
        value={preset}
        onChange={(event) =>
          onPresetChange(event.target.value as DeadlinePreset)
        }
        aria-describedby={
          customError ? `${baseId}-deadline-custom-error` : undefined
        }
      >
        <option value="auto">Auto (recommended)</option>
        <option value="standard">Standard (3 minutes)</option>
        <option value="patient">Patient (5 minutes)</option>
        <option value="custom">Custom…</option>
      </SelectField>
      <TextField
        id={`${baseId}-deadline-custom`}
        label="Custom duration"
        hint={
          preset === "custom"
            ? "Examples: 90s, 3m, 10m. Maximum 10 minutes."
            : "Available when Custom is selected."
        }
        value={customDraft}
        disabled={preset !== "custom"}
        error={preset === "custom" ? customError : null}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        aria-required={preset === "custom"}
        onChange={(event) => onCustomChange(event.target.value)}
      />
      <p className="field__hint" id={`${baseId}-deadline-summary`}>
        {preset === "auto"
          ? "Auto keeps adaptive timing; it does not lock a single fixed ceiling."
          : `Saved ceiling: ${formatDeadlineMs(routerBudget.deadline_ms)} (maximum whole-turn time; ContextDesk may finish sooner).`}
      </p>
    </div>
  );
}
