import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_DESCRIPTION_MAX_LENGTH,
  SOURCE_KINDS,
  SOURCE_NAME_MAX_LENGTH,
  type SourceKind,
  type SourceMutationAction,
  type SourceMutationRefusal,
  type SourceV1,
} from "@cd-collab/contracts/source-catalog";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import type { SourceCatalogGateway } from "./source-catalog/gateway.js";
import {
  useSourceCatalog,
  type SourceCatalogMutationState,
  type SourceCatalogResource,
} from "./source-catalog/use-source-catalog.js";

interface KindMeta {
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
}

const KIND_META: Readonly<Record<SourceKind, KindMeta>> = Object.freeze({
  human: {
    label: "Person",
    hint: "Use the person’s everyday name. This creates an attribution label, not an account.",
    placeholder: "e.g. Priya Sharma (network vendor)",
  },
  "external-tool": {
    label: "External tool",
    hint: "Credit output pasted from a product or assistant. No credentials or connection are created.",
    placeholder: "e.g. Vendor support assistant",
  },
  "internal-system": {
    label: "Internal system",
    hint: "Name the system rather than the operator so its attribution survives team changes.",
    placeholder: "e.g. Grafana alerts",
  },
  contextdesk: {
    label: "ContextDesk",
    hint: "Use this only for ContextDesk output carried into an investigation by hand.",
    placeholder: "e.g. Brief carried from the checkout case",
  },
  unknown: {
    label: "Unknown origin",
    hint: "An honest unknown is permanent and preferable to an invented source.",
    placeholder: "e.g. Unattributed paste from the old ticket",
  },
});

const DEFAULT_KIND: SourceKind = "external-tool";

export interface CatalogProps {
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly gateway?: SourceCatalogGateway;
  readonly keyFactory?: () => string;
}

function sourceRows(resource: SourceCatalogResource): readonly SourceV1[] {
  if (resource.status === "ready") return resource.value;
  if ((resource.status === "loading" || resource.status === "failed") && resource.previous) {
    return resource.previous;
  }
  return [];
}

function kindLabel(kind: SourceKind): string {
  return KIND_META[kind].label;
}

function actionVerb(action: SourceMutationAction): string {
  if (action === "create") return "Adding";
  if (action === "retire") return "Retiring";
  return "Restoring";
}

function refusalCopy(reason: SourceMutationRefusal): string {
  switch (reason) {
    case "expected_revision_mismatch":
      return "This label changed before the action was applied. The latest confirmed record is shown; review it before trying a new action.";
    case "source_revision_unavailable":
      return "This legacy label has no managed revision and remains read-only.";
    case "already_retired":
      return "This label is already retired. The latest confirmed record is shown.";
    case "not_retired":
      return "This label is already active. The latest confirmed record is shown.";
    case "permanent_unknown_protected":
      return "Unknown origin is a permanent safety label and cannot be retired or restored.";
    case "source_not_found":
      return "That label is no longer in the visible catalog. The catalog has been refreshed.";
    case "identity_already_bound":
      return "That identity already has an attribution label. Use the existing label instead.";
    case "idempotency_intent_mismatch":
      return "That saved request key belongs to a different action. Review the current catalog before trying again.";
  }
}

function failureCopy(mutation: Extract<SourceCatalogMutationState, { status: "failed" }>): string {
  switch (mutation.error.kind) {
    case "invalid_request":
    case "invalid":
      return "Check the label fields and try a new action.";
    case "protocol":
      return "The server response could not be validated. No catalog change was assumed.";
    case "internal":
      return "The catalog service could not complete the action. No catalog change was assumed.";
    default:
      return "The action could not be completed. No catalog change was assumed.";
  }
}

function resourceFailureCopy(resource: Extract<SourceCatalogResource, { status: "failed" }>): string {
  const prefix = resource.previous !== undefined
    ? "The latest refresh could not be validated. Previously confirmed labels remain shown."
    : "Attribution labels could not be loaded or validated.";
  return `${prefix} Try loading the catalog again.`;
}

function mutationToken(mutation: SourceCatalogMutationState): string | null {
  if (mutation.status === "idle" || mutation.status === "running") return null;
  if (mutation.status === "succeeded") {
    return `${mutation.status}:${mutation.action}:${mutation.value.appliedRevision}`;
  }
  if (mutation.status === "refused") {
    return `${mutation.status}:${mutation.action}:${mutation.refusal.reason}:${mutation.refusal.expectedRevision}`;
  }
  return `${mutation.status}:${mutation.action}`;
}

function MutationNotice(props: {
  readonly mutation: SourceCatalogMutationState;
  readonly onRetryUnknown: () => void;
  readonly onDismiss: () => void;
  readonly noticeRef: RefObject<HTMLDivElement | null>;
}) {
  const { mutation } = props;
  if (mutation.status === "idle") return null;
  if (mutation.status === "running") {
    return (
      <div className="source-catalog__notice" role="status" aria-live="polite">
        {actionVerb(mutation.action)} the label…
      </div>
    );
  }
  if (mutation.status === "outcome_unknown") {
    return (
      <div
        className="source-catalog__notice source-catalog__notice--warning"
        role="alert"
        tabIndex={-1}
        ref={props.noticeRef}
      >
        <strong>The server may have completed this action.</strong>
        <span>Do not start another catalog change. Retry sends the exact same saved request and key.</span>
        <button type="button" onClick={props.onRetryUnknown}>Retry the same request</button>
      </div>
    );
  }

  const success = mutation.status === "succeeded";
  const message = success
    ? `${mutation.action === "create" ? "Added" : mutation.action === "retire" ? "Retired" : "Restored"} ${mutation.value.applied.name}.`
    : mutation.status === "refused"
      ? refusalCopy(mutation.refusal.reason)
      : failureCopy(mutation);
  return (
    <div
      className={`source-catalog__notice${success ? " source-catalog__notice--success" : " source-catalog__notice--error"}`}
      role={success ? "status" : "alert"}
      aria-live={success ? "polite" : undefined}
      tabIndex={-1}
      ref={props.noticeRef}
    >
      <span>{message}</span>
      <button type="button" onClick={props.onDismiss}>Dismiss</button>
    </div>
  );
}

export function Catalog(props: CatalogProps) {
  const controller = useSourceCatalog({
    enabled: props.canRead,
    canWrite: props.canWrite,
    identityKey: props.identityKey,
    authorityKey: props.authorityKey,
    ...(props.gateway ? { gateway: props.gateway } : {}),
    ...(props.keyFactory ? { keyFactory: props.keyFactory } : {}),
  });
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | SourceKind>("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<"all" | "active" | "retired">("all");
  const [confirmRetireId, setConfirmRetireId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<SourceKind>(DEFAULT_KIND);
  const mutationNoticeRef = useRef<HTMLDivElement>(null);
  const lastFocusedMutationRef = useRef<string | null>(null);

  const rows = sourceRows(controller.resource);
  const counts = useMemo(() => ({
    active: rows.filter((source) => source.lifecycle === "active").length,
    retired: rows.filter((source) => source.lifecycle === "retired").length,
    legacy: rows.filter((source) => source.revision === undefined).length,
  }), [rows]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((source) => {
      if (kindFilter !== "all" && source.kind !== kindFilter) return false;
      if (lifecycleFilter !== "all" && source.lifecycle !== lifecycleFilter) return false;
      if (!needle) return true;
      return [source.name, source.description ?? "", kindLabel(source.kind), source.lifecycle]
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [kindFilter, lifecycleFilter, query, rows]);

  const mutationTokenValue = mutationToken(controller.mutation);
  useEffect(() => {
    if (mutationTokenValue === null || mutationTokenValue === lastFocusedMutationRef.current) return;
    lastFocusedMutationRef.current = mutationTokenValue;
    mutationNoticeRef.current?.focus();
  }, [mutationTokenValue]);
  useEffect(() => {
    if (!props.canWrite) setConfirmRetireId(null);
  }, [props.canWrite]);

  const writeLocked = controller.mutation.status === "running"
    || controller.mutation.status === "outcome_unknown";
  const hasConfirmedRows = controller.resource.status === "ready"
    || ((controller.resource.status === "loading" || controller.resource.status === "failed")
      && controller.resource.previous !== undefined);

  async function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const outcome = await controller.actions.create({ name, kind, description });
    if (outcome.status === "succeeded") {
      setName("");
      setDescription("");
      setKind(DEFAULT_KIND);
    }
  }

  const denied = !props.canRead;
  const initiallyBusy = props.canRead
    && (controller.resource.status === "idle"
      || (controller.resource.status === "loading" && controller.resource.previous === undefined));

  return (
    <section className="source-catalog" aria-labelledby="source-catalog-title" aria-busy={initiallyBusy}>
      <header className="source-catalog__header">
        <div>
          <p className="source-catalog__eyebrow">Attribution</p>
          <h2 id="source-catalog-title">Attribution labels</h2>
          <p>
            Reusable labels record who or what supplied notes, files, and imported answers.
            Evidence stays in its investigation; labels create no account, credential, or connection.
          </p>
        </div>
        {props.canRead ? (
          <button type="button" className="source-catalog__refresh" disabled={initiallyBusy || writeLocked} onClick={controller.actions.refresh}>
            Refresh
          </button>
        ) : null}
      </header>

      {denied ? (
        <div className="source-catalog__message" role="status">
          <h3>Attribution is unavailable in this view</h3>
          <p>Your current account cannot read investigations, so no catalog data was requested.</p>
        </div>
      ) : null}
      {initiallyBusy ? <p className="source-catalog__message" role="status">Loading attribution labels…</p> : null}
      {controller.resource.status === "loading" && controller.resource.previous !== undefined ? (
        <p className="source-catalog__refresh-status" role="status">Refreshing labels. Previously confirmed rows remain shown.</p>
      ) : null}
      {controller.resource.status === "failed" ? (
        <div className="source-catalog__message source-catalog__message--error" role="alert">
          <p>{resourceFailureCopy(controller.resource)}</p>
          <button type="button" onClick={controller.actions.refresh}>Try loading the catalog again</button>
        </div>
      ) : null}
      {!denied ? (
        <MutationNotice
          mutation={controller.mutation}
          noticeRef={mutationNoticeRef}
          onRetryUnknown={() => void controller.actions.retryUnknown()}
          onDismiss={controller.actions.dismissMutation}
        />
      ) : null}

      {hasConfirmedRows ? (
        <>
          <dl className="source-catalog__facts" aria-label="Catalog counts">
            <div><dt>Active</dt><dd>{counts.active}</dd></div>
            <div><dt>Retired</dt><dd>{counts.retired}</dd></div>
            <div><dt>Legacy read-only</dt><dd>{counts.legacy}</dd></div>
          </dl>
          <div className="source-catalog__toolbar" role="search">
            <label><span>Search</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, kind, or description" /></label>
            <label>
              <span>Kind</span>
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as "all" | SourceKind)}>
                <option value="all">All kinds</option>
                {SOURCE_KINDS.map((value) => <option key={value} value={value}>{kindLabel(value)}</option>)}
              </select>
            </label>
            <label>
              <span>Lifecycle</span>
              <select value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value as "all" | "active" | "retired")}>
                <option value="all">Active and retired</option>
                <option value="active">Active</option>
                <option value="retired">Retired</option>
              </select>
            </label>
          </div>
          <p className="source-catalog__result-count" aria-live="polite">
            {filtered.length} of {rows.length} {rows.length === 1 ? "label" : "labels"} shown.
          </p>

          {rows.length === 0 ? (
            <div className="source-catalog__message">
              <h3>No attribution labels are registered yet</h3>
              <p>{props.canWrite ? "Add the first reusable label below." : "A catalog writer can add the first reusable label."}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="source-catalog__message">
              <h3>No labels match these filters</h3>
              <p>Change the search, kind, or lifecycle filter to see other confirmed labels.</p>
            </div>
          ) : (
            <ul className="source-catalog__list" aria-label="Attribution labels">
              {filtered.map((source) => {
                const permanent = source.id === PERMANENT_UNKNOWN_SOURCE_ID;
                const legacy = source.revision === undefined;
                const canChange = props.canWrite && !permanent && !legacy;
                const confirming = confirmRetireId === source.id;
                return (
                  <li key={source.id} className="source-catalog__row">
                    <div className="source-catalog__row-main">
                      <div className="source-catalog__row-title">
                        <strong>{source.name}</strong>
                        <span className={`source-catalog__chip source-catalog__chip--${source.kind}`}>{kindLabel(source.kind)}</span>
                        <span className={`source-catalog__chip source-catalog__chip--${source.lifecycle}`}>{source.lifecycle === "active" ? "Active" : "Retired"}</span>
                        {legacy ? <span className="source-catalog__policy">Legacy record · read-only</span> : null}
                        {permanent ? <span className="source-catalog__policy">Permanent · protected</span> : null}
                      </div>
                      <p className={source.description ? undefined : "source-catalog__muted"}>{source.description || "No description recorded."}</p>
                      <small>Added {source.createdAt.slice(0, 10)}</small>
                    </div>
                    {canChange ? (
                      <div className="source-catalog__row-actions">
                        {source.lifecycle === "active" ? (
                          confirming ? (
                            <>
                              <button
                                type="button"
                                className="source-catalog__danger"
                                disabled={writeLocked}
                                aria-describedby={`retire-note-${source.id}`}
                                onClick={() => { setConfirmRetireId(null); void controller.actions.retire(source.id); }}
                              >
                                Confirm retire {source.name}
                              </button>
                              <button type="button" disabled={writeLocked} onClick={() => setConfirmRetireId(null)}>Keep active</button>
                              <span id={`retire-note-${source.id}`} className="source-catalog__action-note">
                                Retirement hides this label from new intake. Past attribution is preserved.
                              </span>
                            </>
                          ) : (
                            <button type="button" disabled={writeLocked} onClick={() => setConfirmRetireId(source.id)}>Retire {source.name}…</button>
                          )
                        ) : (
                          <button type="button" disabled={writeLocked} onClick={() => void controller.actions.restore(source.id)}>Restore {source.name}</button>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {props.canWrite ? (
            <section className="source-catalog__add" aria-labelledby="source-catalog-add-title">
              <div><h3 id="source-catalog-add-title">Add attribution label</h3><p>Name a source people can select when recording where material came from.</p></div>
              <form onSubmit={(event) => void createSource(event)}>
                <label>
                  <span>Kind</span>
                  <select aria-label="Source kind" value={kind} disabled={writeLocked} onChange={(event) => setKind(event.target.value as SourceKind)}>
                    {SOURCE_KINDS.map((value) => <option key={value} value={value}>{kindLabel(value)}</option>)}
                  </select>
                </label>
                <label className="source-catalog__add-name">
                  <span>Name</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} maxLength={SOURCE_NAME_MAX_LENGTH} placeholder={KIND_META[kind].placeholder} disabled={writeLocked} required />
                </label>
                <label className="source-catalog__add-description">
                  <span>Description <em>(optional)</em></span>
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={SOURCE_DESCRIPTION_MAX_LENGTH} rows={2} disabled={writeLocked} placeholder="Team, purpose, or where people encounter it" />
                </label>
                <p className="source-catalog__hint">{KIND_META[kind].hint}</p>
                <button type="submit" className="source-catalog__primary" disabled={writeLocked || name.trim().length === 0}>Add label</button>
              </form>
            </section>
          ) : (
            <p className="source-catalog__viewer-note" role="note">You can browse attribution labels. Adding, retiring, and restoring labels requires catalog write access.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
