/**
 * The investigation record panel: when the work happened, who and what it
 * involves, and which other investigations it cites.
 *
 * Two rules shape everything here.
 *
 * The first is that an investigation carries two clocks and shows both. A case
 * about something that happened in November 2024 says so, next to the separate
 * fact that it was written down later. A date recorded without a time zone is
 * displayed exactly as it was typed, with the gap stated rather than filled in;
 * only a value that arrived with an offset is rendered as a moment in time.
 *
 * The second is that nothing here is content. Entities are reusable labels,
 * citations are pointers with a reason, and software-impact rows are epistemic
 * judgments about named product/version/build identities — not a build timeline.
 * Evidence, logs, email, chat, and notes stay in the investigation stages
 * where they were captured.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ENTITY_KIND_LABELS, loadEntities, type EntityKind, type EntityRow } from "./Entities.js";
import { protectedApiFetch } from "./protected-api.js";
import { SoftwareImpactPanel } from "./SoftwareImpact.js";

export const INVOLVEMENT_RELATIONSHIPS = [
  "affected",
  "reporting",
  "responsible",
  "observing",
  "referenced",
  "other",
] as const;
export type InvolvementRelationship = (typeof INVOLVEMENT_RELATIONSHIPS)[number];

export const RELATIONSHIP_LABELS: Readonly<Record<InvolvementRelationship, string>> = {
  affected: "Affected by the problem",
  reporting: "Reported the problem",
  responsible: "Operates or owns it",
  observing: "Following the work",
  referenced: "Mentioned in the record",
  other: "Other involvement",
};

export interface InvolvementRow {
  id: string;
  entityId: string;
  relationship: InvolvementRelationship;
  state: "active" | "released";
  note: string;
  recordedLabel: string;
  recordedKind: EntityKind;
  currentLabel: string | null;
  currentKind: EntityKind | null;
  currentLifecycle: "active" | "retired" | null;
  occurredAt: string | null;
  occurredAtPrecision: string;
  occurredAtZone: string;
  recordedAt: string;
  recordedByUsername: string;
  releasedAt: string | null;
}

export interface ReferenceRow {
  id: string;
  fromInvestigationId: string;
  toInvestigationId: string;
  resourceKind: string;
  locator: string;
  note: string;
  recordedTitle: string;
  currentTitle: string | null;
  visibility: "resolved" | "restricted";
  state: "active" | "withdrawn";
  recordedAt: string;
  recordedByUsername: string;
}

export interface OccurrenceFields {
  occurredAt: string | null;
  occurredAtPrecision: string;
  occurredAtZone: string;
}

/** How the recording clock is shown everywhere in this panel. */
export function describeRecordedAt(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Not recorded";
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * How an occurrence is shown. A value with an explicit offset is a real
 * instant and is rendered as one. A value without an offset is shown exactly
 * as it was recorded, with the missing time zone stated — reading it as UTC or
 * as the viewer's local time would both be inventions.
 */
export function describeOccurrence(occurrence: OccurrenceFields): string {
  if (!occurrence.occurredAt) return "Not recorded";
  if (occurrence.occurredAtZone === "explicit") {
    const parsed = new Date(occurrence.occurredAt);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    }
  }
  const precision =
    occurrence.occurredAtPrecision === "year"
      ? "year only"
      : occurrence.occurredAtPrecision === "month"
        ? "month only"
        : occurrence.occurredAtPrecision === "day"
          ? "date only"
          : "time of day recorded";
  return `${occurrence.occurredAt} (${precision}, time zone not recorded)`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const parsed = (await response.json().catch(() => ({}))) as {
    error?: string;
    detail?: string;
  };
  if (parsed.error === "entity_retired") {
    return "That label is retired and cannot be added to new work. Older investigations keep it.";
  }
  if (parsed.error === "already_involved") {
    return "That entity is already involved in this investigation with that relationship.";
  }
  if (parsed.error === "cited_investigation_forbidden") {
    return "You cannot cite that investigation, because you do not have access to read it.";
  }
  if (parsed.error === "already_referenced") {
    return "This investigation already cites that one.";
  }
  return parsed.detail ? `${fallback} ${parsed.detail}` : fallback;
}

export function InvestigationRecordPanel(props: {
  caseId: string;
  canWrite: boolean;
  occurrence: OccurrenceFields;
  createdAt: string | null;
  investigations: readonly { id: string; title: string }[];
  onOccurrenceSaved: () => void | Promise<void>;
  /**
   * Fired after involvement changes. The investigation list filters by entity
   * from a server-built index, so that index has to be re-read here — without
   * it, filtering by an entity just linked returns nothing.
   */
  onInvolvementChanged?: () => void | Promise<void>;
  onOpenInvestigation?: (caseId: string) => void;
}) {
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [involvement, setInvolvement] = useState<InvolvementRow[]>([]);
  const [references, setReferences] = useState<{
    outbound: ReferenceRow[];
    inbound: ReferenceRow[];
  }>({ outbound: [], inbound: [] });
  const [error, setError] = useState<string | null>(null);
  const [occurredDraft, setOccurredDraft] = useState(props.occurrence.occurredAt ?? "");
  const [editingOccurred, setEditingOccurred] = useState(false);
  const [entityDraft, setEntityDraft] = useState({
    entityId: "",
    relationship: "affected" as InvolvementRelationship,
    note: "",
    occurredAt: "",
  });
  const [referenceDraft, setReferenceDraft] = useState({ toInvestigationId: "", note: "" });

  const { caseId } = props;

  /**
   * Each read fails on its own. A panel that blanks entirely because one of
   * three endpoints is unavailable hides the two that answered.
   */
  const refresh = useCallback(async () => {
    setEntities(await loadEntities().catch(() => [] as EntityRow[]));
    try {
      const response = await protectedApiFetch(`/api/cases/${caseId}/involvement`);
      if (response.ok) {
        const parsed = (await response.json()) as { involvements?: InvolvementRow[] };
        setInvolvement(parsed.involvements ?? []);
      }
    } catch {
      setInvolvement([]);
    }
    try {
      const response = await protectedApiFetch(`/api/cases/${caseId}/references`);
      if (response.ok) {
        const parsed = (await response.json()) as {
          outbound?: ReferenceRow[];
          inbound?: ReferenceRow[];
        };
        setReferences({ outbound: parsed.outbound ?? [], inbound: parsed.inbound ?? [] });
      }
    } catch {
      setReferences({ outbound: [], inbound: [] });
    }
  }, [caseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setOccurredDraft(props.occurrence.occurredAt ?? "");
  }, [props.occurrence.occurredAt]);

  const availableEntities = useMemo(
    () => entities.filter((row) => row.lifecycle === "active"),
    [entities],
  );

  async function saveOccurredAt(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const response = await protectedApiFetch(`/api/cases/${caseId}/occurred-at`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ occurredAt: occurredDraft.trim() === "" ? null : occurredDraft.trim() }),
    });
    if (!response.ok) {
      setError(await readError(response, "That date could not be recorded."));
      return;
    }
    setEditingOccurred(false);
    await props.onOccurrenceSaved();
  }

  async function addInvolvement(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!entityDraft.entityId) return;
    const response = await protectedApiFetch(`/api/cases/${caseId}/involvement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entityId: entityDraft.entityId,
        relationship: entityDraft.relationship,
        note: entityDraft.note,
        ...(entityDraft.occurredAt.trim() ? { occurredAt: entityDraft.occurredAt.trim() } : {}),
      }),
    });
    if (!response.ok) {
      setError(await readError(response, "That entity could not be added."));
      return;
    }
    setEntityDraft({ entityId: "", relationship: "affected", note: "", occurredAt: "" });
    await refresh();
    await props.onInvolvementChanged?.();
  }

  async function release(involvementId: string) {
    setError(null);
    const response = await protectedApiFetch(
      `/api/cases/${caseId}/involvement/${involvementId}/release`,
      { method: "POST" },
    );
    if (!response.ok) {
      setError(await readError(response, "That involvement could not be ended."));
      return;
    }
    await refresh();
    await props.onInvolvementChanged?.();
  }

  async function addReference(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!referenceDraft.toInvestigationId) return;
    const response = await protectedApiFetch(`/api/cases/${caseId}/references`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(referenceDraft),
    });
    if (!response.ok) {
      setError(await readError(response, "That reference could not be recorded."));
      return;
    }
    setReferenceDraft({ toInvestigationId: "", note: "" });
    await refresh();
  }

  async function withdraw(referenceId: string) {
    setError(null);
    const response = await protectedApiFetch(
      `/api/cases/${caseId}/references/${referenceId}/withdraw`,
      { method: "POST" },
    );
    if (!response.ok) {
      setError(await readError(response, "That reference could not be withdrawn."));
      return;
    }
    await refresh();
  }

  const activeInvolvement = involvement.filter((row) => row.state === "active");
  const endedInvolvement = involvement.filter((row) => row.state !== "active");

  return (
    <section className="situation__record" aria-labelledby="investigation-record-title">
      <h4 id="investigation-record-title">The record around this investigation</h4>
      {error ? (
        <p className="catalog__error" role="alert">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="record-when-title" className="situation__record-group">
        <h5 id="record-when-title">When</h5>
        <dl className="situation__facts">
          <div>
            <dt>When it happened</dt>
            <dd data-testid="occurred-at">{describeOccurrence(props.occurrence)}</dd>
          </div>
          <div>
            <dt>When it was recorded here</dt>
            <dd data-testid="recorded-at">{describeRecordedAt(props.createdAt)}</dd>
          </div>
        </dl>
        {props.canWrite ? (
          editingOccurred ? (
            <form className="composer" aria-label="Record when this happened" onSubmit={(e) => void saveOccurredAt(e)}>
              <label>
                <span>Date it happened</span>
                <input
                  className="login__input"
                  value={occurredDraft}
                  onChange={(event) => setOccurredDraft(event.target.value)}
                  placeholder="2024-11-04, 2024-11, 2024, or a full timestamp"
                  aria-label="Date it happened"
                />
              </label>
              <p className="triage-step__note">
                A date on its own is fine and is stored exactly as typed. Add a time zone only if
                you actually know it — leaving it out is recorded as not known, not guessed.
              </p>
              <button className="login__submit" type="submit">
                Save when it happened
              </button>
              <button
                type="button"
                className="situation__cancel"
                onClick={() => {
                  setOccurredDraft(props.occurrence.occurredAt ?? "");
                  setEditingOccurred(false);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="catalog__button"
              onClick={() => setEditingOccurred(true)}
            >
              {props.occurrence.occurredAt ? "Change when it happened" : "Record when it happened"}
            </button>
          )
        ) : null}
      </section>

      <SoftwareImpactPanel caseId={caseId} canWrite={props.canWrite} />

      <section aria-labelledby="record-entities-title" className="situation__record-group">
        <h5 id="record-entities-title">Who and what is involved</h5>
        {activeInvolvement.length === 0 ? (
          <p role="status">
            No entities are recorded yet. Naming them makes this investigation findable later by
            the same organization, customer, person, service, or system.
          </p>
        ) : (
          <ul className="catalog__list">
            {activeInvolvement.map((row) => {
              const drifted = row.currentLabel !== null && row.currentLabel !== row.recordedLabel;
              return (
                <li key={row.id} className="catalog__item" data-involvement-id={row.id}>
                  <div className="catalog__item-head">
                    <strong>{row.recordedLabel}</strong>
                    <span className="status-pill">
                      {ENTITY_KIND_LABELS[row.recordedKind] ?? row.recordedKind}
                    </span>
                    <span className="status-pill">{RELATIONSHIP_LABELS[row.relationship]}</span>
                  </div>
                  {drifted ? (
                    <p className="catalog__meta">
                      Recorded here as “{row.recordedLabel}”. Now called “{row.currentLabel}” in
                      Entities.
                    </p>
                  ) : null}
                  {row.currentLifecycle === "retired" ? (
                    <p className="catalog__meta">This label is retired for new work.</p>
                  ) : null}
                  {row.note ? <p>{row.note}</p> : null}
                  <p className="catalog__meta">
                    Involved since: {describeOccurrence(row)} · recorded{" "}
                    {describeRecordedAt(row.recordedAt)} by {row.recordedByUsername}
                  </p>
                  {props.canWrite ? (
                    <button
                      type="button"
                      className="catalog__button"
                      onClick={() => void release(row.id)}
                    >
                      End involvement of {row.recordedLabel}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {endedInvolvement.length > 0 ? (
          <details>
            <summary>Ended involvement ({endedInvolvement.length})</summary>
            <ul className="catalog__list">
              {endedInvolvement.map((row) => (
                <li key={row.id} className="catalog__item">
                  <strong>{row.recordedLabel}</strong>
                  <p className="catalog__meta">
                    Ended {describeRecordedAt(row.releasedAt)}. Kept so the record still shows it
                    was once involved.
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {props.canWrite ? (
          <form className="composer" aria-label="Add an involved entity" onSubmit={(e) => void addInvolvement(e)}>
            <label>
              <span>Entity</span>
              <select
                className="login__input"
                aria-label="Entity"
                value={entityDraft.entityId}
                onChange={(event) =>
                  setEntityDraft((current) => ({ ...current, entityId: event.target.value }))
                }
              >
                <option value="">Choose an entity…</option>
                {availableEntities.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label} · {ENTITY_KIND_LABELS[row.kind] ?? row.kind}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>How it is involved</span>
              <select
                className="login__input"
                aria-label="How it is involved"
                value={entityDraft.relationship}
                onChange={(event) =>
                  setEntityDraft((current) => ({
                    ...current,
                    relationship: event.target.value as InvolvementRelationship,
                  }))
                }
              >
                {INVOLVEMENT_RELATIONSHIPS.map((relationship) => (
                  <option key={relationship} value={relationship}>
                    {RELATIONSHIP_LABELS[relationship]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Involved since</span>
              <input
                className="login__input"
                value={entityDraft.occurredAt}
                onChange={(event) =>
                  setEntityDraft((current) => ({ ...current, occurredAt: event.target.value }))
                }
                placeholder="Optional date, e.g. 2024-11-04"
                aria-label="Involved since"
              />
            </label>
            <label>
              <span>Note</span>
              <input
                className="login__input"
                value={entityDraft.note}
                onChange={(event) =>
                  setEntityDraft((current) => ({ ...current, note: event.target.value }))
                }
                placeholder="One line of context"
                aria-label="Involvement note"
              />
            </label>
            {availableEntities.length === 0 ? (
              <p className="triage-step__note">
                No entities are available yet. Add one in Entities first, so the label can be
                reused by other investigations.
              </p>
            ) : null}
            <button className="login__submit" type="submit">
              Add involved entity
            </button>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="record-references-title" className="situation__record-group">
        <h5 id="record-references-title">Other investigations this one cites</h5>
        <p className="triage-step__note">
          A reference is a link and a reason. It does not copy anything from the other
          investigation, does not change it, and does not become supporting evidence here.
        </p>
        {references.outbound.length === 0 ? (
          <p role="status">No other investigations are cited yet.</p>
        ) : (
          <ul className="catalog__list">
            {references.outbound.map((row) => (
              <li key={row.id} className="catalog__item" data-reference-id={row.id}>
                <div className="catalog__item-head">
                  <strong>
                    {row.visibility === "restricted"
                      ? "Restricted investigation"
                      : (row.currentTitle ?? row.recordedTitle)}
                  </strong>
                  {row.state === "withdrawn" ? (
                    <span className="status-pill status-pill--archived">Withdrawn</span>
                  ) : null}
                </div>
                {row.visibility === "restricted" ? (
                  <p className="activity-feed__restricted">
                    You do not have access to open this investigation. It was cited here as “
                    {row.recordedTitle}”.
                  </p>
                ) : row.currentTitle !== null && row.currentTitle !== row.recordedTitle ? (
                  <p className="catalog__meta">Cited as “{row.recordedTitle}”.</p>
                ) : null}
                {row.note ? <p>{row.note}</p> : null}
                <p className="catalog__meta">
                  Cited {describeRecordedAt(row.recordedAt)} by {row.recordedByUsername}
                </p>
                {row.visibility === "resolved" ? (
                  // A real href, not a button: the locator is the canonical
                  // in-app address, so the citation stays copyable and
                  // followable even where no navigation handler is wired.
                  <a
                    className="catalog__button"
                    href={row.locator}
                    onClick={(event) => {
                      if (!props.onOpenInvestigation) return;
                      event.preventDefault();
                      props.onOpenInvestigation(row.toInvestigationId);
                    }}
                  >
                    Open the cited investigation
                  </a>
                ) : null}
                {props.canWrite && row.state === "active" ? (
                  <button
                    type="button"
                    className="catalog__button"
                    onClick={() => void withdraw(row.id)}
                  >
                    Withdraw this reference
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {references.inbound.length > 0 ? (
          <details>
            <summary>Investigations that cite this one ({references.inbound.length})</summary>
            <ul className="catalog__list">
              {references.inbound.map((row) => (
                <li key={row.id} className="catalog__item">
                  <strong>
                    {row.visibility === "restricted"
                      ? "Restricted investigation"
                      : (row.currentTitle ?? row.recordedTitle)}
                  </strong>
                  <p className="catalog__meta">
                    Cited this investigation as “{row.recordedTitle}” on{" "}
                    {describeRecordedAt(row.recordedAt)}.
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {props.canWrite ? (
          <form className="composer" aria-label="Cite another investigation" onSubmit={(e) => void addReference(e)}>
            <label>
              <span>Investigation</span>
              <select
                className="login__input"
                aria-label="Investigation to cite"
                value={referenceDraft.toInvestigationId}
                onChange={(event) =>
                  setReferenceDraft((current) => ({
                    ...current,
                    toInvestigationId: event.target.value,
                  }))
                }
              >
                <option value="">Choose an investigation…</option>
                {props.investigations
                  .filter((row) => row.id !== caseId)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Why it is relevant</span>
              <input
                className="login__input"
                value={referenceDraft.note}
                onChange={(event) =>
                  setReferenceDraft((current) => ({ ...current, note: event.target.value }))
                }
                placeholder="What connects the two"
                aria-label="Why it is relevant"
              />
            </label>
            <button className="login__submit" type="submit">
              Cite this investigation
            </button>
          </form>
        ) : null}
      </section>
    </section>
  );
}
