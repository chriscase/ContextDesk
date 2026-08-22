/**
 * Investigation team cockpit — the multi-model mode selector.
 *
 * Presents the three host-validated investigation routes (single, review,
 * contributions) as an explicit, keyboard-complete choice with honest
 * readiness detail drawn only from recorded settings fields. Selecting a
 * team changes the default route the composer honors; provider profiles,
 * credentials, qualification, and reconciliation stay host-owned, and the
 * reviewer/contribution routes degrade honestly when their configured roles
 * are unavailable.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  hostGetMultiModelSettings,
  hostSetMultiModelMode,
  type MultiModelSettingsDto,
} from "../../lib/host";

type TeamMode = "single" | "review" | "contributions";

const TEAM_OPTIONS: ReadonlyArray<{
  mode: TeamMode;
  name: string;
  tag: string;
  desc: string;
  recommended?: boolean;
}> = [
  {
    mode: "single",
    name: "Standard",
    tag: "One model, checked by ContextDesk",
    desc: "Your selected model investigates on its own. ContextDesk validates every claim deterministically before anything lands.",
    recommended: true,
  },
  {
    mode: "review",
    name: "Reviewer",
    tag: "Adds a second look when available",
    desc: "Your primary model investigates, then the configured reviewer critiques the result. If the reviewer is unavailable the run continues single-model and records that it did.",
  },
  {
    mode: "contributions",
    name: "Contributions",
    tag: "Bounded roles, reconciled by the host",
    desc: "Only roles you have explicitly configured may contribute, within set bounds. ContextDesk reconciles every contribution and remains the final authority on evidence.",
  },
];

function normalizeMode(mode: string): TeamMode {
  return mode === "review" || mode === "contributions" ? mode : "single";
}

function teamName(mode: TeamMode): string {
  return TEAM_OPTIONS.find((o) => o.mode === mode)?.name ?? mode;
}

export function MultiModelReviewToggle() {
  const [settings, setSettings] = useState<MultiModelSettingsDto | null>(null);
  const [phase, setPhase] = useState<
    "loading" | "absent" | "ready" | "load-error"
  >("loading");
  const [busy, setBusy] = useState(false);
  const [pendingMode, setPendingMode] = useState<TeamMode | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<TeamMode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const baseId = useId();

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const s = await hostGetMultiModelSettings();
      if (!aliveRef.current) return;
      if (s) {
        setSettings(s);
        setPhase("ready");
      } else {
        // No host (browser preview) — keep the surface out of the way.
        setSettings(null);
        setPhase("absent");
      }
    } catch {
      if (aliveRef.current) setPhase("load-error");
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  async function setMode(next: TeamMode) {
    if (busy) return;
    setBusy(true);
    setSaveError(null);
    setNotice(null);
    setLastAttempt(next);
    setPendingMode(next);
    try {
      await hostSetMultiModelMode(next);
      const fresh = await hostGetMultiModelSettings();
      if (!aliveRef.current) return;
      if (fresh) setSettings(fresh);
      setNotice(`Saved — ${teamName(next)} is now the default team.`);
    } catch (err) {
      if (aliveRef.current) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (aliveRef.current) {
        setBusy(false);
        setPendingMode(null);
      }
    }
  }

  if (phase === "absent") return null;

  const titleId = `${baseId}-title`;

  if (phase === "loading") {
    return (
      <section className="settings-block mm-team">
        <h3 className="settings-block__title" id={titleId}>
          Investigation team
        </h3>
        <p className="mm-team__status" role="status">
          Checking the current setup…
        </p>
      </section>
    );
  }

  if (phase === "load-error" || !settings) {
    return (
      <section className="settings-block mm-team">
        <h3 className="settings-block__title" id={titleId}>
          Investigation team
        </h3>
        <div className="mm-team__error" role="alert">
          <p className="mm-team__error-msg">
            Couldn’t load the investigation team settings from the host.
          </p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  const recordedMode = normalizeMode(settings.mode);
  const shownMode = pendingMode ?? recordedMode;
  // A blank or whitespace-only profile id is no reviewer: show the degraded
  // guidance rather than a configured-looking empty identity chip.
  const reviewerProfileId = settings.reviewer_profile_id?.trim() || null;
  const reviewerConfigured = reviewerProfileId != null;

  function optionNote(mode: TeamMode): {
    tone: "warn" | "info";
    text: string;
  } | null {
    if (!settings) return null;
    if (mode === "review") {
      if (!reviewerConfigured) {
        return {
          tone: "warn",
          text: "Not set up yet — no reviewer profile is configured, so runs proceed single-model and record the degradation.",
        };
      }
      const parts: string[] = [];
      if (settings.reviewer_require_qualified) {
        parts.push(
          "The reviewer must pass qualification before it reviews; otherwise the run degrades to single-model and records it.",
        );
      }
      parts.push(
        settings.reviewer_allow_remote
          ? "Remote use is permitted for this reviewer."
          : "Local only — remote reviewer calls are not permitted.",
      );
      return { tone: "info", text: parts.join(" ") };
    }
    if (mode === "contributions") {
      return {
        tone: "info",
        text: "Contribution roles are managed in provider configuration — this screen doesn’t create them. Anything unconfigured or unqualified is skipped and recorded.",
      };
    }
    return null;
  }

  return (
    <section className="settings-block mm-team">
      <h3 className="settings-block__title" id={titleId}>
        Investigation team
      </h3>
      <p className="mm-team__lead" id={`${baseId}-lead`}>
        Choose who works on each investigation. Whatever you pick, ContextDesk
        stays the final authority and validates every claim deterministically.
      </p>

      <div
        className="mm-team__options"
        role="radiogroup"
        aria-labelledby={titleId}
        aria-describedby={`${baseId}-lead`}
        aria-busy={busy || undefined}
        data-busy={busy || undefined}
      >
        {TEAM_OPTIONS.map((opt) => {
          const note = optionNote(opt.mode);
          const nameId = `${baseId}-${opt.mode}-name`;
          const descIds = [
            `${baseId}-${opt.mode}-tag`,
            `${baseId}-${opt.mode}-desc`,
            note ? `${baseId}-${opt.mode}-note` : null,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <label
              key={opt.mode}
              className="mm-team__option"
              data-mode={opt.mode}
              data-selected={shownMode === opt.mode}
            >
              <input
                type="radio"
                className="sr-only mm-team__input"
                name={`${baseId}-team`}
                value={opt.mode}
                checked={shownMode === opt.mode}
                aria-labelledby={nameId}
                aria-describedby={descIds}
                onChange={() => void setMode(opt.mode)}
              />
              <span className="mm-team__option-top">
                <span className="mm-team__option-name" id={nameId}>
                  {opt.name}
                </span>
                {opt.recommended ? (
                  <span className="mm-team__badge">Recommended</span>
                ) : null}
              </span>
              <span
                className="mm-team__option-tag"
                id={`${baseId}-${opt.mode}-tag`}
              >
                {opt.tag}
              </span>
              <span
                className="mm-team__option-desc"
                id={`${baseId}-${opt.mode}-desc`}
              >
                {opt.desc}
              </span>
              {note ? (
                <span
                  className="mm-team__option-note"
                  id={`${baseId}-${opt.mode}-note`}
                  data-tone={note.tone}
                >
                  {note.text}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>

      {busy ? (
        <p className="mm-team__status" role="status" data-busy="true">
          Saving investigation team…
        </p>
      ) : saveError ? (
        <div className="mm-team__error" role="alert">
          <p className="mm-team__error-msg">
            Couldn’t switch to {lastAttempt ? teamName(lastAttempt) : "the new team"}:{" "}
            {saveError}
          </p>
          {lastAttempt ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void setMode(lastAttempt)}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : notice ? (
        <p className="mm-team__status" role="status" data-tone="ok">
          {notice}
        </p>
      ) : null}

      <div className="mm-team__readiness">
        <h4 className="mm-team__readiness-title">Set up right now</h4>
        {reviewerConfigured ? (
          <dl className="mm-team__facts">
            <div className="mm-team__fact">
              <dt>Reviewer profile</dt>
              <dd>
                <code>{reviewerProfileId}</code>
              </dd>
            </div>
            <div className="mm-team__fact">
              <dt>Reviewer model</dt>
              <dd>
                {settings.reviewer_model ? (
                  <code>{settings.reviewer_model}</code>
                ) : (
                  "profile default"
                )}
              </dd>
            </div>
            <div className="mm-team__fact">
              <dt>Qualification</dt>
              <dd>
                {settings.reviewer_require_qualified
                  ? "Required before it reviews"
                  : "Not required"}
              </dd>
            </div>
            <div className="mm-team__fact">
              <dt>Remote access</dt>
              <dd>
                {settings.reviewer_allow_remote
                  ? "Permitted"
                  : "Not permitted — local only"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mm-team__readiness-empty">
            No reviewer is configured. Reviewer mode still saves, but
            investigations run single-model until a reviewer profile is set in
            provider configuration.
          </p>
        )}
        <p className="mm-team__honesty">
          Picking a team changes only the default route. It doesn’t create or
          qualify profiles, and configured is not the same as executed — each
          investigation records which models actually ran.
        </p>
      </div>
    </section>
  );
}
