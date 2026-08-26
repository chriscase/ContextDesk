import "./styles/software-impact.css";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { protectedApiFetch } from "./protected-api.js";

const IMPACT_STATUSES = ["observed", "suspected", "confirmed", "ruled_out"] as const;
type ImpactStatus = (typeof IMPACT_STATUSES)[number];

const IMPACT_FIELDS = ["productName", "version", "build", "component", "environment"] as const;
type ImpactField = (typeof IMPACT_FIELDS)[number];

const FIELD_LABELS: Record<ImpactField, string> = {
  productName: "Software or product",
  version: "Version",
  build: "Build",
  component: "Component",
  environment: "Environment",
};

const STATUS_LABELS: Record<ImpactStatus, string> = {
  observed: "Observed",
  suspected: "Suspected",
  confirmed: "Confirmed",
  ruled_out: "Ruled out",
};

export interface SoftwareImpactRow {
  id: string;
  productName: string;
  version: string;
  build: string;
  component: string;
  environment: string;
  status: ImpactStatus;
  note: string;
  state: "active" | "released";
  recordedAt: string;
  recordedByUsername: string;
  releasedAt: string | null;
}

const EMPTY_DRAFT: Record<ImpactField, string> & { status: ImpactStatus; note: string } = {
  productName: "",
  version: "",
  build: "",
  component: "",
  environment: "",
  status: "suspected",
  note: "",
};

function displayLabel(row: Pick<SoftwareImpactRow, ImpactField>): string {
  const parts = IMPACT_FIELDS.map((field) => row[field]).filter((value) => value.trim().length > 0);
  return parts.join(" · ") || "Unnamed software identity";
}

async function readError(response: Response, fallback: string): Promise<string> {
  const parsed = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (parsed.error === "already_recorded") {
    return "That software identity is already on this investigation. Change its status instead of adding it again.";
  }
  if (parsed.error === "already_released") {
    return "That record has already been ended.";
  }
  if (parsed.error === "not_found") {
    return "This investigation is not available.";
  }
  return parsed.detail ? `${fallback} ${parsed.detail}` : fallback;
}

function ImpactComboBox(props: {
  field: ImpactField;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const listId = `software-impact-options-${props.field}`;
  const label = FIELD_LABELS[props.field];
  return (
    <label>
      <span>{label}</span>
      <input
        className="login__input"
        role="combobox"
        aria-autocomplete="list"
        aria-label={label}
        list={listId}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <datalist id={listId}>
        {props.options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </label>
  );
}

export function SoftwareImpactPanel(props: { caseId: string; canWrite: boolean }) {
  const [records, setRecords] = useState<SoftwareImpactRow[]>([]);
  const [suggestions, setSuggestions] = useState<Record<ImpactField, string[]>>({
    productName: [],
    version: [],
    build: [],
    component: [],
    environment: [],
  });
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const { caseId } = props;

  const refresh = useCallback(async () => {
    try {
      const response = await protectedApiFetch(`/api/cases/${caseId}/software-impact`);
      if (response.status === 404) {
        setAvailable(false);
        setRecords([]);
        return;
      }
      if (!response.ok) {
        setError(await readError(response, "Affected software could not be loaded."));
        return;
      }
      setAvailable(true);
      const parsed = (await response.json()) as { records?: SoftwareImpactRow[] };
      setRecords(Array.isArray(parsed.records) ? parsed.records : []);
    } catch {
      setRecords([]);
    }
    const next: Record<ImpactField, string[]> = {
      productName: [],
      version: [],
      build: [],
      component: [],
      environment: [],
    };
    await Promise.all(
      IMPACT_FIELDS.map(async (field) => {
        try {
          const response = await protectedApiFetch(`/api/software-impact/suggestions?field=${field}`);
          if (!response.ok) return;
          const parsed = (await response.json()) as { values?: string[] };
          next[field] = Array.isArray(parsed.values) ? parsed.values : [];
        } catch {
          next[field] = [];
        }
      }),
    );
    setSuggestions(next);
  }, [caseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = useMemo(() => records.filter((row) => row.state === "active"), [records]);
  const released = useMemo(() => records.filter((row) => row.state !== "active"), [records]);

  async function addRecord(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const response = await protectedApiFetch(`/api/cases/${caseId}/software-impact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      setError(await readError(response, "That impact record could not be saved."));
      return;
    }
    setDraft(EMPTY_DRAFT);
    await refresh();
  }

  async function changeStatus(id: string, status: ImpactStatus) {
    setError(null);
    const response = await protectedApiFetch(`/api/cases/${caseId}/software-impact/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      setError(await readError(response, "That status could not be updated."));
      return;
    }
    await refresh();
  }

  async function release(id: string) {
    setError(null);
    const response = await protectedApiFetch(`/api/cases/${caseId}/software-impact/${id}/release`, {
      method: "POST",
    });
    if (!response.ok) {
      setError(await readError(response, "That record could not be ended."));
      return;
    }
    await refresh();
  }

  if (!available) return null;

  return (
    <section className="software-impact" aria-labelledby="software-impact-title">
      <h5 id="software-impact-title">Affected software</h5>
      <p>
        Record which product, version, build, component, or environment this investigation
        currently treats as observed, suspected, confirmed, or ruled out. These are human
        judgments. Builds are not ordered, and a later version is never inferred.
      </p>
      {error ? (
        <p className="catalog__error" role="alert">
          {error}
        </p>
      ) : null}

      {active.length === 0 ? (
        <p role="status">No affected software is recorded yet.</p>
      ) : (
        <ul className="software-impact__list">
          {active.map((row) => (
            <li key={row.id} className="software-impact__item">
              <div className="software-impact__item-head">
                <strong>{displayLabel(row)}</strong>
                <span className="software-impact__status">{STATUS_LABELS[row.status]}</span>
              </div>
              <p className="software-impact__meta">
                Recorded by {row.recordedByUsername}. This list is in recording order, not
                build order.
              </p>
              {row.note ? <p className="software-impact__note">{row.note}</p> : null}
              {props.canWrite ? (
                <div className="software-impact__actions">
                  <label>
                    <span className="visually-hidden">Status for {displayLabel(row)}</span>
                    <select
                      className="login__input"
                      aria-label={`Status for ${displayLabel(row)}`}
                      value={row.status}
                      onChange={(event) =>
                        void changeStatus(row.id, event.target.value as ImpactStatus)
                      }
                    >
                      {IMPACT_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {STATUS_LABELS[status]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="catalog__button" onClick={() => void release(row.id)}>
                    End this record
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {released.length > 0 ? (
        <details>
          <summary>Ended software impact ({released.length})</summary>
          <ul className="catalog__list">
            {released.map((row) => (
              <li key={row.id} className="catalog__item">
                <strong>{displayLabel(row)}</strong>
                <p className="catalog__meta">
                  {STATUS_LABELS[row.status]} when ended. Kept so the record still shows it was
                  considered.
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {props.canWrite ? (
        <form className="composer software-impact__form" aria-label="Record affected software" onSubmit={(e) => void addRecord(e)}>
          <div className="software-impact__grid">
            {IMPACT_FIELDS.map((field) => (
              <ImpactComboBox
                key={field}
                field={field}
                value={draft[field]}
                options={suggestions[field]}
                onChange={(value) => setDraft((current) => ({ ...current, [field]: value }))}
              />
            ))}
          </div>
          <label>
            <span>Status</span>
            <select
              className="login__input"
              aria-label="Impact status"
              value={draft.status}
              onChange={(event) =>
                setDraft((current) => ({ ...current, status: event.target.value as ImpactStatus }))
              }
            >
              {IMPACT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Note</span>
            <input
              className="login__input"
              aria-label="Impact note"
              value={draft.note}
              onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
              placeholder="Optional one-line reason"
            />
          </label>
          <p className="software-impact__hint">
            Suggestions come from software already recorded on investigations you can open. Type a
            new value when none matches. At least one field is required.
          </p>
          <button className="login__submit" type="submit">
            Record affected software
          </button>
        </form>
      ) : null}
    </section>
  );
}
