import { useCallback, useEffect, useState, type FormEvent } from "react";

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  lifecycle: string;
  description?: string | null;
  createdAt?: string;
}

interface KindMeta {
  label: string;
  meaning: string;
  registerHint: string;
  namePlaceholder: string;
}

const KIND_ORDER = [
  "human",
  "external-tool",
  "internal-system",
  "contextdesk",
  "unknown",
] as const;

type KnownKind = (typeof KIND_ORDER)[number];

const KIND_META: Record<KnownKind, KindMeta> = {
  human: {
    label: "Person",
    meaning:
      "A named person — a colleague or an outside expert. What people write is credited to their own entry.",
    registerHint:
      "Use the person's everyday name. People who sign in usually receive an entry automatically the first time they contribute.",
    namePlaceholder: "e.g. Priya Sharma (network vendor)",
  },
  "external-tool": {
    label: "External tool",
    meaning:
      "A product or AI assistant used outside ContextDesk — a chat assistant, a vendor analyzer. Registering one lets people credit it when pasting its output into a case; ContextDesk never connects to the tool itself.",
    registerHint:
      "This adds the tool to the source picker in a case's manual intake form (“Output from another AI”). No credentials are stored and no automatic access is created — bringing in output stays copy-and-paste.",
    namePlaceholder: "e.g. Claude chat assistant",
  },
  "internal-system": {
    label: "Internal system",
    meaning:
      "One of your own systems — monitoring, ticketing, a runbook store. A person carries its material into a case; the system itself never writes here.",
    registerHint:
      "Name the system rather than the person operating it, so attribution survives team changes.",
    namePlaceholder: "e.g. Grafana alerts",
  },
  contextdesk: {
    label: "ContextDesk",
    meaning:
      "ContextDesk's own output, when a person carries it back in as case material. Model lanes launched inside a case label themselves; this kind is for output brought back by hand.",
    registerHint:
      "Only needed when ContextDesk output re-enters by hand — lanes run inside a case are labeled on their own.",
    namePlaceholder: "e.g. Brief carried over from the checkout case",
  },
  unknown: {
    label: "Unknown origin",
    meaning:
      "Where material came from is honestly not known. Unknown is a permanent, valid answer — never an error, and never upgraded to a guess.",
    registerHint:
      "An honest label for material whose origin can't be established. Recording unknown is better than inventing a source.",
    namePlaceholder: "e.g. Unattributed paste from the old ticket",
  },
};

const DEFAULT_REGISTER_KIND = "external-tool";

function metaFor(kind: string): KindMeta | undefined {
  return (KIND_ORDER as readonly string[]).includes(kind)
    ? KIND_META[kind as KnownKind]
    : undefined;
}

function kindLabel(kind: string): string {
  return metaFor(kind)?.label ?? kind;
}

function kindChipClass(kind: string): string {
  return metaFor(kind) ? `catalog-chip catalog-chip--${kind}` : "catalog-chip";
}

function matchesQuery(source: SourceRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [source.name, source.description ?? "", source.kind, kindLabel(source.kind)]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

function SourceCard(props: {
  source: SourceRow;
  canLead: boolean;
  confirming: boolean;
  onAskRetire: () => void;
  onConfirmRetire: () => void;
  onKeepActive: () => void;
}) {
  const { source } = props;
  const active = source.lifecycle === "active";
  return (
    <li className={`catalog__card${active ? "" : " catalog__card--retired"}`}>
      <div className="catalog__card-head">
        <span className="catalog__name">{source.name}</span>
        <span className={kindChipClass(source.kind)}>{kindLabel(source.kind)}</span>
        <span
          className={`catalog__status${active ? "" : " catalog__status--retired"}`}
        >
          {source.lifecycle}
        </span>
      </div>
      {source.description ? (
        <p className="catalog__desc">{source.description}</p>
      ) : (
        <p className="catalog__desc catalog__desc--none">No description recorded.</p>
      )}
      <p className="catalog__meta">
        <code>{source.kind}</code>
        {source.createdAt ? ` · registered ${source.createdAt.slice(0, 10)}` : null}
      </p>
      {props.canLead && active ? (
        <div className="catalog__actions">
          <button
            type="button"
            className={`catalog__button${props.confirming ? " catalog__button--confirm" : ""}`}
            aria-label={
              props.confirming
                ? `Confirm retire ${source.name}`
                : `Retire ${source.name}`
            }
            {...(props.confirming
              ? { "aria-describedby": `catalog-retire-note-${source.id}` }
              : {})}
            onClick={props.confirming ? props.onConfirmRetire : props.onAskRetire}
          >
            {props.confirming ? "Confirm retire" : "Retire…"}
          </button>
          {props.confirming ? (
            <>
              <button
                type="button"
                className="catalog__button"
                onClick={props.onKeepActive}
              >
                Keep active
              </button>
              <span
                id={`catalog-retire-note-${source.id}`}
                className="catalog__retire-note"
              >
                Retiring hides this source from new intake; every past attribution
                keeps it.
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function Catalog(props: { canLead: boolean }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "error" | "ready">("loading");
  const [createError, setCreateError] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRetireId, setConfirmRetireId] = useState<string | null>(null);
  const [registerKind, setRegisterKind] = useState<string>(DEFAULT_REGISTER_KIND);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/catalog/sources");
      if (!res.ok) {
        setLoadState((prev) => (prev === "ready" ? "ready" : "error"));
        return;
      }
      const body = (await res.json()) as { sources?: SourceRow[] };
      setSources(body.sources ?? []);
      setLoadState("ready");
    } catch {
      setLoadState((prev) => (prev === "ready" ? "ready" : "error"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    try {
      const response = await fetch("/api/catalog/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(data.get("name") ?? ""),
          kind: String(data.get("kind") ?? "unknown"),
          description: String(data.get("description") ?? ""),
        }),
      });
      if (!response.ok) {
        setCreateError(
          "Source could not be added. You may not have permission to manage the catalog.",
        );
        return;
      }
      form.reset();
      setRegisterKind(DEFAULT_REGISTER_KIND);
      await refresh();
      window.dispatchEvent(new Event("contextdesk:source-catalog-changed"));
    } catch {
      setCreateError(
        "Source could not be added. You may not have permission to manage the catalog.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function retire(id: string) {
    setRetireError(null);
    setConfirmRetireId(null);
    try {
      const response = await fetch(`/api/catalog/sources/${id}/retire`, {
        method: "POST",
      });
      if (!response.ok) {
        setRetireError(
          "Source could not be retired. You may not have permission to manage the catalog.",
        );
        return;
      }
      await refresh();
      window.dispatchEvent(new Event("contextdesk:source-catalog-changed"));
    } catch {
      setRetireError(
        "Source could not be retired. You may not have permission to manage the catalog.",
      );
    }
  }

  const active = sources.filter((s) => s.lifecycle === "active");
  const retired = sources.filter((s) => s.lifecycle !== "active");
  const intakeReady = active.filter((s) => s.kind === "external-tool").length;
  const shownActive = active.filter((s) => matchesQuery(s, query));
  const shownRetired = retired.filter((s) => matchesQuery(s, query));
  const shownTotal = shownActive.length + shownRetired.length;
  const filtering = query.trim().length > 0;

  function groupCount(shown: number, total: number): string {
    return filtering ? `${shown} of ${total}` : `${total}`;
  }

  const registerMeta = metaFor(registerKind) ?? KIND_META.unknown;

  return (
    <section
      className="catalog"
      aria-labelledby="catalog-title"
      aria-busy={loadState === "loading"}
    >
      <header>
        <p className="case-memory__eyebrow">Provenance</p>
        <h2 id="catalog-title" className="catalog__title">
          Source &amp; provenance library
        </h2>
        <p className="catalog__copy">
          Cases credit every note, upload, and imported answer to a source — who or
          what produced it. This library holds those labels. A source is attribution
          only: it is not a login or a live connection, and naming one never makes
          material correct.
        </p>
      </header>

      {loadState === "loading" ? (
        <p className="catalog__loading" role="status">
          Loading the source library…
        </p>
      ) : null}

      {loadState === "error" ? (
        <div className="catalog__load-error">
          <p role="alert">The source library could not be loaded. Try again.</p>
          <button
            type="button"
            className="catalog__button"
            onClick={() => {
              setLoadState("loading");
              void refresh();
            }}
          >
            Retry loading sources
          </button>
        </div>
      ) : null}

      {loadState === "ready" ? (
        <>
          <dl className="catalog__facts">
            <div className="catalog__fact">
              <dt>Active sources</dt>
              <dd>
                <strong>{active.length}</strong>
                <span>selectable when new material is recorded</span>
              </dd>
            </div>
            <div className="catalog__fact">
              <dt>Retired sources</dt>
              <dd>
                <strong>{retired.length}</strong>
                <span>hidden from new intake; past attributions keep them</span>
              </dd>
            </div>
            <div className="catalog__fact">
              <dt>External tools for manual intake</dt>
              <dd>
                <strong>{intakeReady}</strong>
                <span>
                  active external tools people can credit when pasting output into a
                  case
                </span>
              </dd>
            </div>
          </dl>

          <section className="catalog__kinds" aria-labelledby="catalog-kinds-title">
            <h3 id="catalog-kinds-title">What the five kinds mean</h3>
            <ul className="catalog__kind-cards">
              {KIND_ORDER.map((kind) => {
                const meta = KIND_META[kind];
                const count = active.filter((s) => s.kind === kind).length;
                return (
                  <li key={kind} className="catalog__kind-card">
                    <div className="catalog__kind-card-head">
                      <span className={kindChipClass(kind)}>{meta.label}</span>
                      <code>{kind}</code>
                    </div>
                    <p>{meta.meaning}</p>
                    <span className="catalog__kind-count">
                      {count === 0
                        ? "none active yet"
                        : `${count} active ${count === 1 ? "source" : "sources"}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          {sources.length === 0 ? (
            <div className="catalog__empty">
              <p className="catalog__empty-title">No sources are registered yet.</p>
              <p>
                {props.canLead
                  ? "Register the first one below. Teams usually start with the external tools whose output they paste into cases."
                  : "A case lead can register the first one; browsing stays open to everyone."}
              </p>
            </div>
          ) : (
            <>
              <div className="catalog__toolbar" role="search">
                <label className="catalog__filter">
                  <span>Filter</span>
                  <input
                    type="search"
                    className="login__input"
                    aria-label="Filter sources"
                    placeholder="Name, kind, or description"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <p className="catalog__filter-result" aria-live="polite">
                  {filtering
                    ? `${shownTotal} of ${sources.length} ${sources.length === 1 ? "source matches" : "sources match"}.`
                    : ""}
                </p>
              </div>

              {retireError ? (
                <p className="case-memory__error" role="alert">
                  {retireError}
                </p>
              ) : null}

              <section
                className="catalog__group"
                aria-labelledby="catalog-active-title"
              >
                <h3 id="catalog-active-title">
                  Active sources ({groupCount(shownActive.length, active.length)})
                </h3>
                <p className="catalog__group-copy">
                  These can be credited when new material is recorded on a case.
                </p>
                {active.length === 0 ? (
                  <p className="case-memory__empty">
                    No active sources. Retired entries below keep their history.
                  </p>
                ) : shownActive.length === 0 ? (
                  <p className="case-memory__empty">
                    No active sources match the filter.
                  </p>
                ) : (
                  <ul className="catalog__cards">
                    {shownActive.map((s) => (
                      <SourceCard
                        key={s.id}
                        source={s}
                        canLead={props.canLead}
                        confirming={confirmRetireId === s.id}
                        onAskRetire={() => setConfirmRetireId(s.id)}
                        onConfirmRetire={() => void retire(s.id)}
                        onKeepActive={() => setConfirmRetireId(null)}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {retired.length > 0 ? (
                <section
                  className="catalog__group"
                  aria-labelledby="catalog-retired-title"
                >
                  <h3 id="catalog-retired-title">
                    Retired sources ({groupCount(shownRetired.length, retired.length)})
                  </h3>
                  <p className="catalog__group-copy">
                    Retired sources no longer appear for new intake. Every past
                    contribution keeps its attribution — retirement hides, it never
                    rewrites.
                  </p>
                  {shownRetired.length === 0 ? (
                    <p className="case-memory__empty">
                      No retired sources match the filter.
                    </p>
                  ) : (
                    <ul className="catalog__cards">
                      {shownRetired.map((s) => (
                        <SourceCard
                          key={s.id}
                          source={s}
                          canLead={props.canLead}
                          confirming={false}
                          onAskRetire={() => undefined}
                          onConfirmRetire={() => undefined}
                          onKeepActive={() => undefined}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
            </>
          )}

          {props.canLead ? (
            <section
              className="catalog__register"
              aria-labelledby="catalog-register-title"
            >
              <h3 id="catalog-register-title">Register a source</h3>
              <p className="catalog__group-copy">
                Registering creates an attribution label for people to pick when
                recording where material came from. It stores a name and a
                description — no credentials, no connection, and no access.
              </p>
              {createError ? (
                <p className="case-memory__error" role="alert">
                  {createError}
                </p>
              ) : null}
              <form className="catalog__form" onSubmit={(e) => void createSource(e)}>
                <fieldset className="catalog__kind-picker">
                  <legend>What kind of source is this?</legend>
                  {KIND_ORDER.map((kind) => (
                    <label key={kind} className="catalog__kind-option">
                      <input
                        type="radio"
                        name="kind"
                        value={kind}
                        defaultChecked={kind === DEFAULT_REGISTER_KIND}
                        onChange={() => setRegisterKind(kind)}
                      />
                      <span>
                        <strong>{KIND_META[kind].label}</strong>
                        <small>
                          <code>{kind}</code>
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <p className="catalog__register-hint">{registerMeta.registerHint}</p>
                <label className="catalog__field">
                  Name
                  <input
                    className="login__input"
                    name="name"
                    aria-label="Source name"
                    placeholder={registerMeta.namePlaceholder}
                    required
                  />
                </label>
                <label className="catalog__field">
                  Description (optional)
                  <textarea
                    className="login__input"
                    name="description"
                    aria-label="Source description"
                    rows={2}
                    placeholder="Which team runs it, which version, or where it lives"
                  />
                </label>
                <button className="login__submit" type="submit" disabled={saving}>
                  Add source
                </button>
              </form>
            </section>
          ) : (
            <p className="catalog__viewer-note" role="note">
              You&rsquo;re browsing with read access. Registering and retiring
              sources is reserved for case leads; everything recorded here stays
              visible to you.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
