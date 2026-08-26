/**
 * The Entities area: reusable labels for what investigations are about.
 *
 * This is deliberately a sibling of Attribution rather than a tab inside it.
 * Attribution answers "where did this information come from"; Entities answers
 * "who or what is this investigation about". A vendor is often both, and they
 * stay two rows with two lifecycles, because collapsing them is how a registry
 * of labels quietly becomes a directory of everything.
 *
 * Neither area holds evidence, logs, email, chat, or notes. Those stay in the
 * investigation where they were captured.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { protectedApiFetch } from "./protected-api.js";

export const ENTITY_KINDS = [
  "organization",
  "customer",
  "person",
  "service",
  "system",
  "other",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_KIND_LABELS: Readonly<Record<EntityKind, string>> = {
  organization: "Organization",
  customer: "Customer",
  person: "Person",
  service: "Service",
  system: "System",
  other: "Other",
};

export interface EntityRow {
  id: string;
  kind: EntityKind;
  label: string;
  profile: { summary: string; reference: string } | null;
  privacyClass: "owner_only" | "share_safe";
  lifecycle: "active" | "retired";
  createdAt?: string;
  updatedAt?: string;
}

interface EntityListResponse {
  entities?: EntityRow[];
}

export async function loadEntities(): Promise<EntityRow[]> {
  const response = await protectedApiFetch("/api/entities");
  if (!response.ok) throw new Error("entities unavailable");
  const parsed = (await response.json()) as EntityListResponse;
  return parsed.entities ?? [];
}

function kindLabel(kind: string): string {
  return ENTITY_KIND_LABELS[kind as EntityKind] ?? kind;
}

const EMPTY_DRAFT = {
  kind: "organization" as EntityKind,
  label: "",
  summary: "",
  reference: "",
  shareSafe: false,
};

export function Entities(props: { canWrite: boolean; canLead: boolean }) {
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const refresh = useCallback(async () => {
    try {
      setEntities(await loadEntities());
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createEntity(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
    const response = await protectedApiFetch("/api/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: draft.kind,
        label: draft.label,
        privacyClass: draft.shareSafe ? "share_safe" : "owner_only",
        ...(draft.summary.trim() || draft.reference.trim()
          ? { profile: { summary: draft.summary, reference: draft.reference } }
          : {}),
      }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      setActionError(
        detail.error === "entity_exists"
          ? "That label already exists for this kind. Use the existing one so the record stays reusable."
          : detail.detail
            ? `The label could not be added. ${detail.detail}`
            : "The label could not be added. You may not have permission to add one.",
      );
      return;
    }
    setDraft(EMPTY_DRAFT);
    await refresh();
  }

  async function retire(id: string) {
    setActionError(null);
    const response = await protectedApiFetch(`/api/entities/${id}/retire`, { method: "POST" });
    if (!response.ok) {
      setActionError("The label could not be retired. You may not have permission to retire one.");
      return;
    }
    await refresh();
  }

  const matching = entities.filter((row) => {
    if (kindFilter !== "all" && row.kind !== kindFilter) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      row.label.toLowerCase().includes(needle) ||
      (row.profile?.summary ?? "").toLowerCase().includes(needle) ||
      (row.profile?.reference ?? "").toLowerCase().includes(needle)
    );
  });
  const active = matching.filter((row) => row.lifecycle === "active");
  const retired = matching.filter((row) => row.lifecycle !== "active");

  return (
    <section
      className="catalog"
      aria-labelledby="entities-title"
      aria-busy={loadState === "loading"}
    >
      <header>
        <p className="case-memory__eyebrow">Entities</p>
        <h2 id="entities-title" className="catalog__title">
          Who and what investigations are about
        </h2>
        <p className="catalog__copy">
          Reusable labels name the organizations, customers, people, services, and systems an
          investigation concerns, so the same party can be found again years later instead of
          retyped into a slightly different phrase. A label is not an account, and nothing here
          connects to the named party.
        </p>
        <p className="catalog__copy">
          This area holds labels only. Logs, files, email, chat, and notes stay inside the
          investigation where they were captured. Attribution, next door, is a separate list: it
          records where a piece of information came from, not who the work is about.
        </p>
      </header>

      {loadState === "loading" ? (
        <p className="catalog__loading" role="status">
          Loading entities…
        </p>
      ) : null}

      {loadState === "error" ? (
        <div className="catalog__load-error">
          <p role="alert">Entities could not be loaded. Try again.</p>
          <button
            type="button"
            className="catalog__button"
            onClick={() => {
              setLoadState("loading");
              void refresh();
            }}
          >
            Retry loading entities
          </button>
        </div>
      ) : null}

      {loadState === "ready" ? (
        <>
          {actionError ? (
            <p className="catalog__error" role="alert">
              {actionError}
            </p>
          ) : null}

          <div className="case-list__controls">
            <label className="case-list__search">
              <span className="case-list__control-label">Search</span>
              <input
                className="login__input"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Label, description, or reference"
                aria-label="Search entities by label, description, or reference"
              />
            </label>
            <label className="case-list__filter">
              <span className="case-list__control-label">Kind</span>
              <select
                className="login__input"
                aria-label="Filter entities by kind"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value)}
              >
                <option value="all">All kinds</option>
                {ENTITY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {ENTITY_KIND_LABELS[kind]} (
                    {entities.filter((row) => row.kind === kind).length})
                  </option>
                ))}
              </select>
            </label>
          </div>

          {props.canWrite ? (
            <form className="case-form" aria-label="Add an entity" onSubmit={(e) => void createEntity(e)}>
              <label className="case-form__label" htmlFor="new-entity-label">
                Add an entity
              </label>
              <div className="case-form__row">
                <select
                  className="login__input"
                  aria-label="Entity kind"
                  value={draft.kind}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, kind: event.target.value as EntityKind }))
                  }
                >
                  {ENTITY_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {ENTITY_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <input
                  id="new-entity-label"
                  className="login__input"
                  // The visible label heads the whole form; the field needs its
                  // own name so the two are distinguishable to a screen reader.
                  aria-label="Entity name"
                  value={draft.label}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, label: event.target.value }))
                  }
                  placeholder="Name as a person would say it"
                  required
                />
                <button className="login__submit" type="submit">
                  Add entity
                </button>
              </div>
              <div className="case-form__situation">
                <label>
                  <span>Description</span>
                  <input
                    className="login__input"
                    value={draft.summary}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, summary: event.target.value }))
                    }
                    placeholder="One line. Not a place for logs or notes."
                  />
                </label>
                <label>
                  <span>Local reference</span>
                  <input
                    className="login__input"
                    value={draft.reference}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, reference: event.target.value }))
                    }
                    placeholder="An identifier a reader here would recognise"
                  />
                </label>
              </div>
              <label className="import-warn">
                <input
                  type="checkbox"
                  checked={draft.shareSafe}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, shareSafe: event.target.checked }))
                  }
                />
                <span>
                  This name may appear in a share-safe export. Leave unchecked and the label stays
                  inside the tool: a share-safe export shows the kind and a stable stand-in instead.
                </span>
              </label>
            </form>
          ) : null}

          <section aria-labelledby="entities-active-title" className="catalog__group">
            <h3 id="entities-active-title">Available ({active.length})</h3>
            {active.length === 0 ? (
              <p role="status">No entities match the current search or filter.</p>
            ) : null}
            <ul className="catalog__list">
              {active.map((row) => (
                <li key={row.id} className="catalog__item" data-entity-id={row.id}>
                  <div className="catalog__item-head">
                    <strong>{row.label}</strong>
                    <span className="status-pill">{kindLabel(row.kind)}</span>
                    <span className="status-pill">
                      {row.privacyClass === "share_safe" ? "May leave the tool" : "Stays internal"}
                    </span>
                  </div>
                  {row.profile?.summary ? <p>{row.profile.summary}</p> : null}
                  {row.profile?.reference ? (
                    <p className="catalog__meta">Reference: {row.profile.reference}</p>
                  ) : null}
                  {props.canLead ? (
                    <button
                      type="button"
                      className="catalog__button"
                      onClick={() => void retire(row.id)}
                    >
                      Retire {row.label}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="entities-retired-title" className="catalog__group">
            <h3 id="entities-retired-title">Retired ({retired.length})</h3>
            <p className="catalog__copy">
              A retired label cannot be chosen for new work. Investigations that already name it
              keep reading exactly as they were written.
            </p>
            <ul className="catalog__list">
              {retired.map((row) => (
                <li key={row.id} className="catalog__item" data-entity-id={row.id}>
                  <div className="catalog__item-head">
                    <strong>{row.label}</strong>
                    <span className="status-pill">{kindLabel(row.kind)}</span>
                    <span className="status-pill status-pill--archived">Retired</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </section>
  );
}
