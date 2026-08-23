/**
 * Investigation team cockpit — the multi-model mode selector plus reviewer
 * assignment.
 *
 * Presents the three host-validated investigation routes (single, review,
 * contributions) as an explicit, keyboard-complete choice, and lets an
 * existing provider profile be assigned the reviewer role. Readiness detail
 * is drawn only from recorded settings fields and the host's cached measured
 * qualification; provider profiles, credentials, probes, and reconciliation
 * stay host-owned. Assignment records configuration only — every review turn
 * re-checks qualification and egress itself, and the reviewer/contribution
 * routes degrade honestly when their configured roles are unavailable.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  hostGetMultiModelSettings,
  hostSetMultiModelMode,
  hostSetMultiModelContributors,
  hostSetMultiModelReviewer,
  type ContributionPolicyDto,
  type ContributionRole,
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

type MeasuredQualification = "qualified" | "unqualified" | "unverified";

/**
 * Normalize the host's measured verdict for display. Anything that is not an
 * explicit measured pass/fail — including an unexpected value — reads as
 * unverified: unverified is never qualified.
 */
function measuredQualification(s: MultiModelSettingsDto): MeasuredQualification {
  if (s.reviewer_qualification === "qualified") return "qualified";
  if (s.reviewer_qualification === "unqualified") return "unqualified";
  return "unverified";
}

const QUALIFICATION_LABEL: Record<MeasuredQualification, string> = {
  qualified: "Measured qualified",
  unqualified: "Measured — did not qualify",
  unverified: "Not measured yet (unverified)",
};

type ContributorDraft = {
  role: ContributionRole;
  profileId: string;
  model: string;
  allowRemote: boolean;
};

const CONTRIBUTION_ROLES: ReadonlyArray<{
  role: ContributionRole;
  name: string;
  purpose: string;
}> = [
  {
    role: "observation_extractor",
    name: "Observation extractor",
    purpose: "Pulls host-grounded facts from the bounded evidence packet.",
  },
  {
    role: "timeline_analyst",
    name: "Timeline analyst",
    purpose: "Checks chronology without changing host-owned ordering.",
  },
  {
    role: "causal_proposer",
    name: "Causal proposer",
    purpose: "Proposes hypotheses and alternatives, never an established root cause.",
  },
  {
    role: "contradiction_checker",
    name: "Contradiction checker",
    purpose: "Challenges disagreement, contradictions, and unsupported certainty.",
  },
  {
    role: "evidence_gap",
    name: "Evidence-gap scout",
    purpose: "Names useful evidence that is absent from the frozen packet.",
  },
  {
    role: "reviewer",
    name: "Final contribution reviewer",
    purpose: "Optionally reviews reconciled contributions; must remain the last role.",
  },
];

const DEFAULT_CONTRIBUTION_POLICY: ContributionPolicyDto = {
  max_contributors: 4,
  max_parallel: 3,
  max_rounds: 2,
  max_context_chars: 120_000,
  max_total_provider_rounds: 12,
  max_semantic_corrections_per_stage: 1,
  max_context_chars_total: null,
};

function contributionName(role: ContributionRole): string {
  return CONTRIBUTION_ROLES.find((option) => option.role === role)?.name ?? role;
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
  // Reviewer-assignment draft. Synced from recorded settings on load and
  // after an assignment save; never clobbered by a mode save.
  const [draftProfileId, setDraftProfileId] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftAllowRemote, setDraftAllowRemote] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignNotice, setAssignNotice] = useState<string | null>(null);
  const [lastAssign, setLastAssign] = useState<"save" | "clear" | null>(null);
  const [contributorDrafts, setContributorDrafts] = useState<ContributorDraft[]>([]);
  const [contributionPolicy, setContributionPolicy] =
    useState<ContributionPolicyDto>(DEFAULT_CONTRIBUTION_POLICY);
  const [contributionBusy, setContributionBusy] = useState(false);
  const [contributionError, setContributionError] = useState<string | null>(null);
  const [contributionNotice, setContributionNotice] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const baseId = useId();

  const syncDraft = useCallback((s: MultiModelSettingsDto) => {
    setDraftProfileId(s.reviewer_profile_id?.trim() ?? "");
    setDraftModel(s.reviewer_model ?? "");
    setDraftAllowRemote(s.reviewer_allow_remote);
    setContributorDrafts(
      (s.contribution_assignments ?? []).map((assignment) => ({
        role: assignment.role,
        profileId: assignment.profile_id,
        model: assignment.model ?? "",
        allowRemote: assignment.allow_remote,
      })),
    );
    setContributionPolicy(
      s.contribution_policy ?? DEFAULT_CONTRIBUTION_POLICY,
    );
  }, []);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const s = await hostGetMultiModelSettings();
      if (!aliveRef.current) return;
      if (s) {
        setSettings(s);
        syncDraft(s);
        setPhase("ready");
      } else {
        // No host (browser preview) — keep the surface out of the way.
        setSettings(null);
        setPhase("absent");
      }
    } catch {
      if (aliveRef.current) setPhase("load-error");
    }
  }, [syncDraft]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  async function setMode(next: TeamMode) {
    if (busy || assignBusy || contributionBusy) return;
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

  async function submitAssignment(kind: "save" | "clear") {
    if (busy || assignBusy || contributionBusy || !settings) return;
    setAssignBusy(true);
    setAssignError(null);
    setAssignNotice(null);
    setLastAssign(kind);
    try {
      const profileId = kind === "clear" ? null : draftProfileId.trim() || null;
      const candidate =
        profileId != null
          ? (settings.candidate_profiles.find((c) => c.id === profileId) ??
            null)
          : null;
      // Measured qualification is mandatory — the host records it and offers
      // the renderer no way to relax it, so it is not sent here.
      await hostSetMultiModelReviewer({
        profileId,
        model: profileId != null ? draftModel.trim() || null : null,
        // A local-only profile cannot egress, so no acknowledgement is ever
        // submitted for one; consent applies to remote profiles only.
        allowRemote:
          profileId != null && candidate?.local_only !== true
            ? draftAllowRemote
            : false,
      });
      const fresh = await hostGetMultiModelSettings();
      if (!aliveRef.current) return;
      if (fresh) {
        setSettings(fresh);
        syncDraft(fresh);
      }
      setAssignNotice(
        profileId != null
          ? "Saved — reviewer assignment recorded. Nothing runs until a review-mode investigation turn."
          : "Saved — reviewer cleared. Review-mode turns proceed single-model and record it.",
      );
    } catch (err) {
      if (aliveRef.current) {
        setAssignError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (aliveRef.current) setAssignBusy(false);
    }
  }

  function updateContributor(index: number, patch: Partial<ContributorDraft>) {
    setContributorDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, ...patch } : draft,
      ),
    );
    setContributionError(null);
    setContributionNotice(null);
  }

  function addContributor() {
    setContributorDrafts((current) => {
      const next: ContributorDraft = {
        role: "observation_extractor",
        profileId: "",
        model: "",
        allowRemote: false,
      };
      const reviewerIndex = current.findIndex((draft) => draft.role === "reviewer");
      if (reviewerIndex < 0) return [...current, next];
      return [
        ...current.slice(0, reviewerIndex),
        next,
        ...current.slice(reviewerIndex),
      ];
    });
    setContributionError(null);
    setContributionNotice(null);
  }

  function removeContributor(index: number) {
    setContributorDrafts((current) =>
      current.filter((_, draftIndex) => draftIndex !== index),
    );
    setContributionError(null);
    setContributionNotice(null);
  }

  function moveContributor(index: number, direction: -1 | 1) {
    setContributorDrafts((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setContributionError(null);
    setContributionNotice(null);
  }

  async function saveContributionTeam() {
    if (busy || assignBusy || contributionBusy || !settings) return;
    setContributionBusy(true);
    setContributionError(null);
    setContributionNotice(null);
    try {
      await hostSetMultiModelContributors({
        assignments: contributorDrafts.map((draft) => ({
          role: draft.role,
          profileId: draft.profileId.trim(),
          model: draft.model.trim() || null,
          allowRemote: draft.allowRemote,
        })),
        policy: {
          maxContributors: contributionPolicy.max_contributors,
          maxParallel: contributionPolicy.max_parallel,
          maxRounds: contributionPolicy.max_rounds,
          maxContextChars: contributionPolicy.max_context_chars,
          maxTotalProviderRounds:
            contributionPolicy.max_total_provider_rounds,
          maxSemanticCorrectionsPerStage:
            contributionPolicy.max_semantic_corrections_per_stage,
          maxContextCharsTotal:
            contributionPolicy.max_context_chars_total,
        },
      });
      const fresh = await hostGetMultiModelSettings();
      if (!aliveRef.current) return;
      if (fresh) {
        setSettings(fresh);
        syncDraft(fresh);
      }
      setContributionNotice(
        contributorDrafts.length === 0
          ? "Saved — contribution roles cleared. Contributions mode will use the deterministic floor and record the missing setup."
          : `Saved — ${contributorDrafts.length} contribution role${contributorDrafts.length === 1 ? "" : "s"} recorded. Nothing runs until a linked Contributions investigation.`,
      );
    } catch (error) {
      if (aliveRef.current) {
        setContributionError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (aliveRef.current) setContributionBusy(false);
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
  const candidates = settings.candidate_profiles;
  const qualification = measuredQualification(settings);

  // Recorded readiness gates — what stands between the recorded assignment
  // and an actual review at turn time. Never claims a review will happen.
  const recordedCandidate = reviewerConfigured
    ? (candidates.find((c) => c.id === reviewerProfileId) ?? null)
    : null;
  // Egress identity of the recorded reviewer, derived from the profile's
  // actual locality plus the acknowledgement — never from the acknowledgement
  // alone. A remote profile without acknowledgement is still remote; only a
  // profile that is genuinely local-only may be described as local.
  const recordedEgress: "local" | "remote-acknowledged" | "remote-unacknowledged" | "unavailable" =
    recordedCandidate == null
      ? "unavailable"
      : recordedCandidate.local_only
        ? "local"
        : settings.reviewer_allow_remote
          ? "remote-acknowledged"
          : "remote-unacknowledged";
  const gates: string[] = [];
  if (reviewerConfigured) {
    if (!recordedCandidate) {
      gates.push("the recorded profile no longer exists in provider settings");
    } else if (!recordedCandidate.local_only && !settings.reviewer_allow_remote) {
      gates.push("remote evidence egress is not acknowledged");
    }
    if (settings.reviewer_require_qualified && qualification !== "qualified") {
      gates.push(
        qualification === "unqualified"
          ? "the measured qualification failed"
          : "qualification has not been measured yet",
      );
    }
  }

  // Assignment-editor derived state.
  const selectedCandidate =
    candidates.find((c) => c.id === draftProfileId) ?? null;
  const selectedIsRemote = selectedCandidate != null && !selectedCandidate.local_only;
  const draftMissing = draftProfileId !== "" && selectedCandidate == null;
  const activeProfileId = settings.active_profile_id?.trim() || null;
  const effectiveDraftModel =
    draftModel.trim() || selectedCandidate?.chat_model || "";
  const sameAsInvestigator =
    selectedCandidate != null &&
    activeProfileId === selectedCandidate.id &&
    effectiveDraftModel === selectedCandidate.chat_model;

  function onPickProfile(id: string) {
    setDraftProfileId(id);
    const cand = candidates.find((c) => c.id === id) ?? null;
    const isRecorded = reviewerConfigured && id === reviewerProfileId;
    // Egress consent never carries across profiles: restore the recorded
    // acknowledgement only when returning to the recorded remote reviewer.
    setDraftAllowRemote(
      Boolean(
        cand &&
          !cand.local_only &&
          isRecorded &&
          settings?.reviewer_allow_remote,
      ),
    );
    setDraftModel(isRecorded ? (settings?.reviewer_model ?? "") : "");
  }

  const recordedContributionAssignments = settings.contribution_assignments ?? [];
  const eligibleContributionCount = recordedContributionAssignments.filter(
    (assignment) => {
      const candidate = candidates.find(
        (row) => row.id === assignment.profile_id,
      );
      return (
        candidate != null &&
        assignment.qualification === "qualified" &&
        (candidate.local_only || assignment.allow_remote)
      );
    },
  ).length;
  const contributionValidation: string[] = [];
  if (
    contributorDrafts.some(
      (draft) =>
        draft.profileId.trim() === "" ||
        !candidates.some((candidate) => candidate.id === draft.profileId),
    )
  ) {
    contributionValidation.push("every role needs an existing provider profile");
  }
  if (contributorDrafts.length > contributionPolicy.max_contributors) {
    contributionValidation.push("role count exceeds the contributor cap");
  }
  const reviewerDrafts = contributorDrafts.filter(
    (draft) => draft.role === "reviewer",
  );
  if (reviewerDrafts.length > 1) {
    contributionValidation.push("only one final reviewer is allowed");
  }
  if (
    reviewerDrafts.length === 1 &&
    contributorDrafts.at(-1)?.role !== "reviewer"
  ) {
    contributionValidation.push("the final reviewer must be the last role");
  }
  if (
    contributionPolicy.max_contributors < 1 ||
    contributionPolicy.max_contributors > 8
  ) {
    contributionValidation.push("contributor cap must be between 1 and 8");
  }
  if (
    contributionPolicy.max_parallel < 1 ||
    contributionPolicy.max_parallel > contributionPolicy.max_contributors
  ) {
    contributionValidation.push("parallel calls must fit the contributor cap");
  }
  if (
    contributionPolicy.max_rounds < 1 ||
    contributionPolicy.max_rounds > 2
  ) {
    contributionValidation.push("contribution rounds must be 1 or 2");
  }
  if (
    contributionPolicy.max_context_chars < 24_000 ||
    contributionPolicy.max_context_chars > 2_000_000
  ) {
    contributionValidation.push("context characters must be 24,000–2,000,000");
  }
  if (
    contributionPolicy.max_total_provider_rounds < 1 ||
    contributionPolicy.max_total_provider_rounds > 64
  ) {
    contributionValidation.push("provider rounds must be 1–64");
  }
  if (
    contributionPolicy.max_semantic_corrections_per_stage < 0 ||
    contributionPolicy.max_semantic_corrections_per_stage > 4
  ) {
    contributionValidation.push("semantic corrections must be 0–4");
  }
  if (
    contributionPolicy.max_context_chars_total != null &&
    (contributionPolicy.max_context_chars_total < 1 ||
      contributionPolicy.max_context_chars_total > 16_000_000)
  ) {
    contributionValidation.push("total model-facing characters must be 1–16,000,000");
  }

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
        {
          local:
            "The reviewer profile is local-only; evidence never leaves this machine.",
          "remote-acknowledged":
            "Remote evidence egress is acknowledged for this reviewer.",
          "remote-unacknowledged":
            "This reviewer is a remote provider and egress is not acknowledged, so review degrades to single-model and records it.",
          unavailable:
            "The recorded reviewer profile is unavailable, so egress cannot be evaluated and review degrades.",
        }[recordedEgress],
      );
      return { tone: "info", text: parts.join(" ") };
    }
    if (mode === "contributions") {
      if (recordedContributionAssignments.length === 0) {
        return {
          tone: "warn",
          text: "Not set up yet — no contribution roles are recorded, so linked turns use the deterministic floor and record the missing setup.",
        };
      }
      return {
        tone: "info",
        text: `${recordedContributionAssignments.length} role${recordedContributionAssignments.length === 1 ? " is" : "s are"} recorded; ${eligibleContributionCount} currently ${eligibleContributionCount === 1 ? "has" : "have"} measured qualification and egress readiness. Runtime re-checks every role and records what actually ran.`,
      };
    }
    return null;
  }

  const assignSaveDisabled = assignBusy || busy || contributionBusy;
  const assignClearDisabled =
    assignBusy ||
    busy ||
    contributionBusy ||
    (!reviewerConfigured && draftProfileId === "");
  const contributionSaveDisabled =
    busy ||
    assignBusy ||
    contributionBusy ||
    contributionValidation.length > 0;

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

      <fieldset
        className="mm-team__assign"
        aria-busy={assignBusy || undefined}
        aria-describedby={`${baseId}-assign-lead`}
      >
        <legend className="mm-team__assign-title">Reviewer assignment</legend>
        <p className="mm-team__assign-lead" id={`${baseId}-assign-lead`}>
          Assign an existing provider profile the reviewer role. Saving records
          the assignment only — nothing runs until a review-mode investigation
          turn, and each turn re-checks qualification and egress first.
        </p>

        <div className="mm-team__assign-grid">
          <div className="mm-team__assign-field">
            <label
              className="mm-team__assign-label"
              htmlFor={`${baseId}-assign-profile`}
            >
              Profile
            </label>
            <select
              id={`${baseId}-assign-profile`}
              className="mm-team__assign-control"
              value={draftProfileId}
              onChange={(e) => onPickProfile(e.currentTarget.value)}
            >
              <option value="">No reviewer</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} — {c.chat_model}
                  {c.local_only ? " (local)" : " (remote)"}
                </option>
              ))}
              {draftMissing ? (
                <option value={draftProfileId}>
                  {draftProfileId} (not found)
                </option>
              ) : null}
            </select>
          </div>

          <div className="mm-team__assign-field">
            <label
              className="mm-team__assign-label"
              htmlFor={`${baseId}-assign-model`}
            >
              Model override{" "}
              <span className="mm-team__assign-optional">(optional)</span>
            </label>
            <input
              id={`${baseId}-assign-model`}
              className="mm-team__assign-control"
              type="text"
              value={draftModel}
              disabled={draftProfileId === ""}
              aria-describedby={`${baseId}-assign-model-hint`}
              onChange={(e) => setDraftModel(e.currentTarget.value)}
            />
            <p
              className="mm-team__assign-hint"
              id={`${baseId}-assign-model-hint`}
            >
              Empty uses the profile default
              {selectedCandidate ? ` (${selectedCandidate.chat_model})` : ""}.
            </p>
          </div>
        </div>

        {selectedIsRemote ? (
          <div className="mm-team__assign-ack">
            <input
              id={`${baseId}-assign-ack`}
              type="checkbox"
              checked={draftAllowRemote}
              aria-describedby={`${baseId}-assign-ack-desc`}
              onChange={(e) => setDraftAllowRemote(e.currentTarget.checked)}
            />
            <div className="mm-team__assign-ack-text">
              <label htmlFor={`${baseId}-assign-ack`}>
                Allow remote evidence egress for review
              </label>
              <p id={`${baseId}-assign-ack-desc`}>
                Review turns would send investigation evidence — prompts and
                bounded context from your linked logs — to this remote
                provider. Without this acknowledgement the assignment still
                saves, but review turns proceed single-model and record it.
              </p>
            </div>
          </div>
        ) : selectedCandidate ? (
          <p className="mm-team__assign-note">
            Local-only profile — evidence never leaves this machine, so no
            egress acknowledgement applies.
          </p>
        ) : null}

        {sameAsInvestigator ? (
          <p className="mm-team__assign-note">
            Same profile and model as the current investigator. That’s allowed
            — the reviewer is a second prompt in a second role, not a second
            model. It can still catch mistakes, but it shares this model’s
            blind spots.
          </p>
        ) : null}

        <div className="mm-team__assign-actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={assignSaveDisabled}
            onClick={() => void submitAssignment("save")}
          >
            Save reviewer
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={assignClearDisabled}
            onClick={() => void submitAssignment("clear")}
          >
            Clear reviewer
          </button>
        </div>

        {assignBusy ? (
          <p className="mm-team__status" role="status" data-busy="true">
            Saving reviewer assignment…
          </p>
        ) : assignError ? (
          <div className="mm-team__error" role="alert">
            <p className="mm-team__error-msg">
              Couldn’t save the reviewer assignment: {assignError}
            </p>
            {lastAssign ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void submitAssignment(lastAssign)}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : assignNotice ? (
          <p className="mm-team__status" role="status" data-tone="ok">
            {assignNotice}
          </p>
        ) : null}
      </fieldset>

      <fieldset
        className="mm-team__contributors"
        aria-busy={contributionBusy || undefined}
        aria-describedby={`${baseId}-contributors-lead`}
      >
        <legend className="mm-team__assign-title">Contribution team</legend>
        <p className="mm-team__assign-lead" id={`${baseId}-contributors-lead`}>
          Build an ordered team for linked investigations. Each role receives
          only the bounded host evidence packet. Models may propose, challenge,
          or abstain; ContextDesk reconciles their structured output and keeps
          causal and decision authority.
        </p>

        <div className="mm-team__contributor-list">
          {contributorDrafts.length === 0 ? (
            <p className="mm-team__readiness-empty">
              No contribution roles yet. Contributions mode will use the
              deterministic floor and record that no model roles were admitted.
            </p>
          ) : null}
          {contributorDrafts.map((draft, index) => {
            const candidate =
              candidates.find((row) => row.id === draft.profileId) ?? null;
            const recorded = recordedContributionAssignments[index];
            const recordedQualification: MeasuredQualification =
              recorded?.profile_id === draft.profileId &&
              recorded.role === draft.role &&
              (recorded.model ?? "") === draft.model
                ? recorded.qualification === "qualified"
                  ? "qualified"
                  : recorded.qualification === "unqualified"
                    ? "unqualified"
                    : "unverified"
                : "unverified";
            const descriptionId = `${baseId}-contributor-${index}-description`;
            return (
              <article className="mm-team__contributor" key={index}>
                <div className="mm-team__contributor-head">
                  <div>
                    <strong>Role {index + 1}</strong>
                    <span className="mm-team__contributor-purpose" id={descriptionId}>
                      {CONTRIBUTION_ROLES.find(
                        (option) => option.role === draft.role,
                      )?.purpose ?? "Bounded model contribution."}
                    </span>
                  </div>
                  <div className="mm-team__contributor-order">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={index === 0 || contributionBusy}
                      aria-label={`Move ${contributionName(draft.role)} earlier`}
                      onClick={() => moveContributor(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={
                        index === contributorDrafts.length - 1 ||
                        contributionBusy
                      }
                      aria-label={`Move ${contributionName(draft.role)} later`}
                      onClick={() => moveContributor(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={contributionBusy}
                      aria-label={`Remove ${contributionName(draft.role)}`}
                      onClick={() => removeContributor(index)}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="mm-team__contributor-grid">
                  <div className="mm-team__assign-field">
                    <label
                      className="mm-team__assign-label"
                      htmlFor={`${baseId}-contributor-${index}-role`}
                    >
                      Responsibility
                    </label>
                    <select
                      id={`${baseId}-contributor-${index}-role`}
                      className="mm-team__assign-control"
                      value={draft.role}
                      aria-describedby={descriptionId}
                      onChange={(event) =>
                        updateContributor(index, {
                          role: event.currentTarget.value as ContributionRole,
                        })
                      }
                    >
                      {CONTRIBUTION_ROLES.map((option) => (
                        <option key={option.role} value={option.role}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mm-team__assign-field">
                    <label
                      className="mm-team__assign-label"
                      htmlFor={`${baseId}-contributor-${index}-profile`}
                    >
                      Provider profile
                    </label>
                    <select
                      id={`${baseId}-contributor-${index}-profile`}
                      className="mm-team__assign-control"
                      value={draft.profileId}
                      onChange={(event) => {
                        const profileId = event.currentTarget.value;
                        updateContributor(index, {
                          profileId,
                          model: "",
                          allowRemote: false,
                        });
                      }}
                    >
                      <option value="">Choose a profile…</option>
                      {candidates.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.label} — {row.chat_model}
                          {row.local_only ? " (local)" : " (remote)"}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mm-team__assign-field">
                    <label
                      className="mm-team__assign-label"
                      htmlFor={`${baseId}-contributor-${index}-model`}
                    >
                      Model override <span className="mm-team__assign-optional">(optional)</span>
                    </label>
                    <input
                      id={`${baseId}-contributor-${index}-model`}
                      className="mm-team__assign-control"
                      value={draft.model}
                      disabled={!candidate}
                      onChange={(event) =>
                        updateContributor(index, {
                          model: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                </div>

                {candidate && !candidate.local_only ? (
                  <label className="mm-team__contributor-egress">
                    <input
                      type="checkbox"
                      checked={draft.allowRemote}
                      onChange={(event) =>
                        updateContributor(index, {
                          allowRemote: event.currentTarget.checked,
                        })
                      }
                    />
                    <span>
                      Allow this remote role to receive the bounded evidence
                      packet. Without acknowledgement it is skipped and recorded.
                    </span>
                  </label>
                ) : candidate ? (
                  <p className="mm-team__assign-note">
                    Local-only profile — no remote egress applies.
                  </p>
                ) : null}

                <p className="mm-team__contributor-status">
                  <span
                    className="mm-team__qual"
                    data-state={recordedQualification}
                  >
                    {QUALIFICATION_LABEL[recordedQualification]}
                  </span>{" "}
                  Qualification is mandatory and measured by the host; this
                  editor cannot bypass it.
                </p>
              </article>
            );
          })}
        </div>

        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={
            contributionBusy ||
            contributorDrafts.length >= contributionPolicy.max_contributors ||
            contributorDrafts.length >= 8
          }
          onClick={addContributor}
        >
          Add contribution role
        </button>

        <details className="mm-team__budget">
          <summary>Advanced limits</summary>
          <p className="mm-team__assign-hint">
            Hard host ceilings, not targets. Lower limits may skip roles or
            corrections; the execution receipt reports what actually happened.
          </p>
          <div className="mm-team__budget-grid">
            {(
              [
                ["max_contributors", "Contributor cap", 1, 8],
                ["max_parallel", "Parallel calls", 1, 8],
                ["max_rounds", "Contribution phases", 1, 2],
                ["max_context_chars", "Packet characters", 24_000, 2_000_000],
                ["max_total_provider_rounds", "Provider-call cap", 1, 64],
                [
                  "max_semantic_corrections_per_stage",
                  "Corrections per stage",
                  0,
                  4,
                ],
              ] as const
            ).map(([field, label, min, max]) => (
              <label className="mm-team__budget-field" key={field}>
                <span>{label}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={contributionPolicy[field]}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    setContributionPolicy((current) => ({
                      ...current,
                      [field]: value,
                    }));
                  }}
                />
              </label>
            ))}
            <label className="mm-team__budget-field">
              <span>Total model-facing characters (optional)</span>
              <input
                type="number"
                min={1}
                max={16_000_000}
                placeholder="No total cap"
                value={contributionPolicy.max_context_chars_total ?? ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setContributionPolicy((current) => ({
                    ...current,
                    max_context_chars_total:
                      value.trim() === ""
                        ? null
                        : Number(value),
                  }));
                }}
              />
            </label>
          </div>
        </details>

        {contributionValidation.length > 0 ? (
          <p className="mm-team__gate" data-tone="warn" role="alert">
            Fix before saving: {contributionValidation.join("; ")}.
          </p>
        ) : null}

        <div className="mm-team__assign-actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={contributionSaveDisabled}
            onClick={() => void saveContributionTeam()}
          >
            Save contribution team
          </button>
        </div>

        {contributionBusy ? (
          <p className="mm-team__status" role="status" data-busy="true">
            Saving contribution team…
          </p>
        ) : contributionError ? (
          <div className="mm-team__error" role="alert">
            <p className="mm-team__error-msg">
              Couldn’t save the contribution team: {contributionError}
            </p>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void saveContributionTeam()}
            >
              Try again
            </button>
          </div>
        ) : contributionNotice ? (
          <p className="mm-team__status" role="status" data-tone="ok">
            {contributionNotice}
          </p>
        ) : null}

        <div className="mm-team__execution-truth">
          <strong>Configured is not executed.</strong> Linked Contributions
          turns re-check every role’s profile, measured qualification, egress,
          credentials, and budget. Activity Inspector records admitted,
          completed, skipped, malformed, failed, timed-out, and cancelled stages.
        </div>
      </fieldset>

      <div className="mm-team__readiness">
        <h4 className="mm-team__readiness-title">Set up right now</h4>
        {reviewerConfigured ? (
          <>
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
                <dt>Qualification policy</dt>
                <dd>
                  {settings.reviewer_require_qualified
                    ? "Required before it reviews"
                    : "Not required"}
                </dd>
              </div>
              <div className="mm-team__fact">
                <dt>Measured qualification</dt>
                <dd>
                  <span className="mm-team__qual" data-state={qualification}>
                    {QUALIFICATION_LABEL[qualification]}
                  </span>
                </dd>
              </div>
              <div className="mm-team__fact">
                <dt>Remote access</dt>
                <dd>
                  {
                    {
                      local: "Local-only profile — no remote egress applies",
                      "remote-acknowledged":
                        "Remote provider — egress acknowledged",
                      "remote-unacknowledged":
                        "Remote provider — egress not acknowledged",
                      unavailable:
                        "Profile unavailable — egress cannot be evaluated",
                    }[recordedEgress]
                  }
                </dd>
              </div>
            </dl>
            {gates.length > 0 ? (
              <p className="mm-team__gate" data-tone="warn">
                Not ready — {gates.join("; ")}. Review-mode turns proceed
                single-model and record the degradation.
              </p>
            ) : (
              <p className="mm-team__gate" data-tone="ok">
                Recorded and eligible. Each review turn still re-checks
                qualification and egress at run time — assignment alone never
                runs anything, and review applies only to Log Explorer–linked
                investigation turns.
              </p>
            )}
          </>
        ) : (
          <p className="mm-team__readiness-empty">
            No reviewer is configured. Reviewer mode still saves, but
            investigations run single-model until a reviewer profile is
            assigned above.
          </p>
        )}
        <p className="mm-team__honesty">
          Picking a team or assigning a reviewer changes only the recorded
          configuration. It doesn’t create or qualify profiles, and configured
          is not the same as executed — each investigation records which
          models actually ran.
        </p>
      </div>
    </section>
  );
}
