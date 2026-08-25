import {
  ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_CSRF_HEADER,
  ADMIN_PEOPLE_CSRF_HEADER_VALUE,
  ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_MAX_PAGE_SIZE,
  ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_SEARCH_MAX_LENGTH,
  ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID,
  DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  DIRECTORY_MAPPED_FIELDS,
  PROFILE_PROVENANCE,
  PROFILE_STATUS,
  parseAdminPeopleEffective,
  parseAdminPeopleListResponse,
  type AppRole,
  type Capability,
  type DirectoryMappedField,
  type EffectiveCapabilityV1,
  type ProfileProvenance,
  type ProfileStatus,
  type UserProfileV1,
} from "@cd-collab/contracts/admin";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { protectedApiFetch } from "./protected-api.js";

const STATUS_LABELS: Record<ProfileStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  disabled: "Disabled",
};

const PROVENANCE_LABELS: Record<ProfileProvenance, string> = {
  local: "Local",
  ldap: "LDAP",
  oidc: "OIDC",
  imported_historical: "Imported (historical)",
};

function csrfHeaders(): Record<string, string> {
  return { "content-type": "application/json", [ADMIN_PEOPLE_CSRF_HEADER]: ADMIN_PEOPLE_CSRF_HEADER_VALUE };
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function boundedError(response: Response, action: string): string {
  if (response.status === 400) return `${action} was rejected because the request is invalid.`;
  if (response.status === 403) return `${action} is not allowed for the current session.`;
  if (response.status === 404) return `${action} could not find that person. Refresh and try again.`;
  if (response.status === 409) return `${action} could not finish because the person changed. Refresh and try again.`;
  if (response.status === 503) return `${action} is temporarily unavailable. No change was confirmed.`;
  return `${action} failed. No change was confirmed.`;
}

type PendingAction =
  | { kind: "status"; person: UserProfileV1; nextStatus: ProfileStatus }
  | { kind: "grant"; person: UserProfileV1; capability: Capability }
  | { kind: "revoke"; person: UserProfileV1; capability: Capability };

function ConfirmDialog(props: { action: PendingAction; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const { action } = props;
  const title =
    action.kind === "status"
      ? `${action.nextStatus === "active" ? "Reactivate" : "Suspend"} ${action.person.username}?`
      : action.kind === "grant"
        ? `Grant ${action.capability} to ${action.person.username}?`
        : `Revoke ${action.capability} from ${action.person.username}?`;
  const copy =
    action.kind === "status"
      ? action.nextStatus === "active"
        ? "This restores whatever roles and local grants the account already had."
        : "This immediately zeroes every capability for this account, regardless of role or local grant."
      : action.kind === "grant"
        ? "This adds one capability on top of whatever the account's roles already grant."
        : "This removes only this one local grant. Role-derived capabilities are unaffected.";
  return (
    <div
      className="admin-confirm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <section
        className="admin-confirm__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-people-confirm-title"
        aria-describedby="admin-people-confirm-copy"
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onCancel();
        }}
      >
        <h2 id="admin-people-confirm-title">{title}</h2>
        <p id="admin-people-confirm-copy">{copy}</p>
        <div className="admin-confirm__actions">
          <button ref={cancelRef} type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="admin-button admin-button--danger" type="button" onClick={props.onConfirm}>
            Confirm
          </button>
        </div>
      </section>
    </div>
  );
}

export function AdminPeoplePanel() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const [people, setPeople] = useState<UserProfileV1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProfileStatus | "">("");
  const [provenanceFilter, setProvenanceFilter] = useState<ProfileProvenance | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [effective, setEffective] = useState<{ roles: AppRole[]; capabilities: EffectiveCapabilityV1[] } | null>(null);
  const [effectiveLoading, setEffectiveLoading] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const [sampleClaims, setSampleClaims] = useState("cn=Synthetic Analyst\nmail=synthetic@example.test");
  const [preview, setPreview] = useState<{ fields: Partial<Record<DirectoryMappedField, string>>; skipped: DirectoryMappedField[] } | null>(null);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => headingRef.current?.focus(), []);

  const search = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError("");
      try {
        const response = await protectedApiFetch("/api/admin/people/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaId: ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID,
            term,
            status: statusFilter || null,
            provenance: provenanceFilter || null,
            cursor,
            limit: ADMIN_PEOPLE_MAX_PAGE_SIZE,
          }),
        });
        if (!response.ok) {
          setError(boundedError(response, "Search"));
          if (!cursor) setPeople([]);
          setNextCursor(null);
          return;
        }
        const parsed = parseAdminPeopleListResponse(await response.json());
        setPeople((current) => (cursor ? [...current, ...parsed.people] : parsed.people));
        setNextCursor(parsed.nextCursor);
      } catch {
        setError("Search returned data this console could not validate. No directory data is shown.");
        if (!cursor) setPeople([]);
        setNextCursor(null);
      } finally {
        setLoading(false);
      }
    },
    [term, statusFilter, provenanceFilter],
  );

  useEffect(() => {
    // Re-search from the first page whenever a filter changes; term is
    // submitted explicitly via the form below, not on every keystroke.
    void search(null);
  }, [statusFilter, provenanceFilter]);

  async function loadEffective(id: string) {
    setEffectiveLoading(true);
    setEffective(null);
    try {
      const response = await protectedApiFetch(`/api/admin/people/${encodeURIComponent(id)}/effective`);
      if (!response.ok) {
        setError(boundedError(response, "Loading effective capabilities"));
        return;
      }
      const parsed = parseAdminPeopleEffective(await response.json());
      setEffective({ roles: parsed.roles, capabilities: parsed.capabilities });
    } catch {
      setError("Effective capabilities could not be validated. No permission data is shown.");
    } finally {
      setEffectiveLoading(false);
    }
  }

  function toggleExpanded(person: UserProfileV1) {
    if (expandedId === person.id) {
      setExpandedId(null);
      setEffective(null);
      return;
    }
    setExpandedId(person.id);
    void loadEffective(person.id);
  }

  async function runPendingAction(action: PendingAction) {
    setPending(null);
    setError("");
    setNotice("");
    try {
      if (action.kind === "status") {
        const response = await protectedApiFetch(
          `/api/admin/people/${encodeURIComponent(action.person.id)}/status`,
          {
            method: "POST",
            headers: csrfHeaders(),
            body: JSON.stringify({
              schemaId: ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID,
              status: action.nextStatus,
              expectedRevision: action.person.revision,
              idempotencyKey: newIdempotencyKey(),
            }),
          },
        );
        if (!response.ok) {
          setError(boundedError(response, "Status change"));
          window.setTimeout(() => errorRef.current?.focus(), 0);
          return;
        }
        setNotice(`${action.person.username} is now ${STATUS_LABELS[action.nextStatus].toLowerCase()}.`);
      } else {
        const url = `/api/admin/people/${encodeURIComponent(action.person.id)}/grants`;
        const response = await protectedApiFetch(url, {
          method: action.kind === "grant" ? "POST" : "DELETE",
          headers: csrfHeaders(),
          body: JSON.stringify({
            schemaId: action.kind === "grant" ? ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID : ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID,
            capability: action.capability,
            idempotencyKey: newIdempotencyKey(),
          }),
        });
        if (!response.ok) {
          setError(boundedError(response, action.kind === "grant" ? "Grant" : "Revoke"));
          window.setTimeout(() => errorRef.current?.focus(), 0);
          return;
        }
        setNotice(
          action.kind === "grant"
            ? `${action.capability} was granted to ${action.person.username}.`
            : `${action.capability} was revoked from ${action.person.username}.`,
        );
      }
      window.setTimeout(() => statusRef.current?.focus(), 0);
      await search(null);
      if (expandedId === action.person.id) await loadEffective(action.person.id);
    } catch {
      setError("The change could not reach the workspace server. No change was confirmed.");
      window.setTimeout(() => errorRef.current?.focus(), 0);
    }
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    setPreviewError("");
    setPreview(null);
    const claims: Record<string, string> = {};
    for (const line of sampleClaims.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      claims[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    try {
      const response = await protectedApiFetch("/api/admin/directory/mapping/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID,
          map: DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
          sampleClaims: claims,
        }),
      });
      if (!response.ok) {
        setPreviewError(boundedError(response, "Preview"));
        return;
      }
      const body = (await response.json()) as {
        fields: Partial<Record<DirectoryMappedField, string>>;
        skipped: DirectoryMappedField[];
      };
      setPreview({ fields: body.fields, skipped: body.skipped });
    } catch {
      setPreviewError("Preview returned data this console could not validate.");
    }
  }

  return (
    <section className="admin-people" aria-labelledby="admin-people-title">
      <header className="admin-people__intro">
        <h3 id="admin-people-title" ref={headingRef} tabIndex={-1}>
          People
        </h3>
        <p>
          Installation-scoped user profiles created the first time someone signs in. This never
          creates a directory identity or grants a role by itself - it inspects and locally
          authorizes people who have already authenticated at least once.
        </p>
      </header>

      {error ? (
        <p ref={errorRef} tabIndex={-1} className="administration__message administration__message--error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p ref={statusRef} tabIndex={-1} className="administration__message" role="status">
          {notice}
        </p>
      ) : null}

      <section className="administration__panel" aria-labelledby="admin-people-search-title">
        <h4 id="admin-people-search-title">Find people</h4>
        <form
          className="admin-people__search"
          onSubmit={(event) => {
            event.preventDefault();
            void search(null);
          }}
        >
          <label htmlFor="admin-people-term">Username or display name</label>
          <input
            id="admin-people-term"
            value={term}
            maxLength={ADMIN_PEOPLE_SEARCH_MAX_LENGTH}
            onChange={(event) => setTerm(event.target.value)}
          />
          <label htmlFor="admin-people-status">Status</label>
          <select
            id="admin-people-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as ProfileStatus | "")}
          >
            <option value="">Any</option>
            {PROFILE_STATUS.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
          <label htmlFor="admin-people-provenance">Provenance</label>
          <select
            id="admin-people-provenance"
            value={provenanceFilter}
            onChange={(event) => setProvenanceFilter(event.target.value as ProfileProvenance | "")}
          >
            <option value="">Any</option>
            {PROFILE_PROVENANCE.map((value) => (
              <option key={value} value={value}>
                {PROVENANCE_LABELS[value]}
              </option>
            ))}
          </select>
          <button type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>

        {loading && people.length === 0 ? (
          <p role="status">Loading people…</p>
        ) : people.length === 0 ? (
          <p>No people match this search.</p>
        ) : (
          <div className="administration__table-wrap">
            <table className="administration__table">
              <thead>
                <tr>
                  <th scope="col">Username</th>
                  <th scope="col">Display name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Provenance</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <Fragment key={person.id}>
                    <tr>
                      <th scope="row">{person.username}</th>
                      <td>{person.displayName}</td>
                      <td>{STATUS_LABELS[person.status]}</td>
                      <td>{PROVENANCE_LABELS[person.provenance]}</td>
                      <td>{person.lastSeenAt ? new Date(person.lastSeenAt).toLocaleString() : "Never"}</td>
                      <td className="administration__row-actions">
                        <button type="button" onClick={() => toggleExpanded(person)}>
                          {expandedId === person.id ? "Hide" : "Manage"}
                        </button>
                      </td>
                    </tr>
                    {expandedId === person.id ? (
                      <tr>
                        <td colSpan={6}>
                          <div className="admin-people__detail">
                            <div className="admin-people__detail-actions">
                              {person.provenance !== "imported_historical" ? (
                                <button
                                  type="button"
                                  className="admin-button--danger-text"
                                  onClick={() =>
                                    setPending({
                                      kind: "status",
                                      person,
                                      nextStatus: person.status === "active" ? "suspended" : "active",
                                    })
                                  }
                                >
                                  {person.status === "active" ? "Suspend" : "Reactivate"}
                                </button>
                              ) : (
                                <p role="note">
                                  Historical import - attribution only. This profile can never
                                  authenticate or hold a capability.
                                </p>
                              )}
                            </div>
                            {effectiveLoading ? (
                              <p role="status">Loading effective roles and capabilities…</p>
                            ) : effective ? (
                              <>
                                <p>
                                  Roles: {effective.roles.length > 0 ? effective.roles.join(", ") : "none"}
                                </p>
                                <table className="administration__table admin-people__capability-table">
                                  <thead>
                                    <tr>
                                      <th scope="col">Capability</th>
                                      <th scope="col">Via role</th>
                                      <th scope="col">Local grant</th>
                                      <th scope="col">Action</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {effective.capabilities.map((row) => (
                                      <tr key={row.capability}>
                                        <th scope="row"><code>{row.capability}</code></th>
                                        <td>{row.viaRoles.length > 0 ? row.viaRoles.join(", ") : "—"}</td>
                                        <td>{row.viaLocalGrant ? `Yes (${row.grantedBy ?? "unknown"})` : "No"}</td>
                                        <td>
                                          {person.provenance === "imported_historical" ? null : row.viaLocalGrant ? (
                                            <button
                                              type="button"
                                              className="admin-button--danger-text"
                                              onClick={() => setPending({ kind: "revoke", person, capability: row.capability })}
                                            >
                                              Revoke
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() => setPending({ kind: "grant", person, capability: row.capability })}
                                            >
                                              Grant
                                            </button>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor ? (
          <button type="button" onClick={() => void search(nextCursor)} disabled={loading}>
            Load more
          </button>
        ) : null}
      </section>

      <section className="administration__panel" aria-labelledby="admin-people-preview-title">
        <h4 id="admin-people-preview-title">Preview a directory mapping</h4>
        <p>
          Enter synthetic sample attributes (one <code>name=value</code> per line) to see how the
          default LDAP-style attribute map would populate a profile. This never contacts a real
          directory and never persists anything.
        </p>
        <form className="admin-people__preview-form" onSubmit={(event) => void runPreview(event)}>
          <label htmlFor="admin-people-sample-claims">Sample claims</label>
          <textarea
            id="admin-people-sample-claims"
            rows={4}
            value={sampleClaims}
            onChange={(event) => setSampleClaims(event.target.value)}
          />
          <button type="submit">Preview mapping</button>
        </form>
        {previewError ? <p role="alert">{previewError}</p> : null}
        {preview ? (
          <dl className="admin-people__preview-result">
            {DIRECTORY_MAPPED_FIELDS.map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>{preview.fields[field] ?? <em>not supplied</em>}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      <aside className="administration__boundary" aria-labelledby="admin-people-boundary-title">
        <h3 id="admin-people-boundary-title">Authority boundary</h3>
        <p>
          Suspending, disabling, or revoking here takes effect immediately for every capability
          check, regardless of role. Historical/imported profiles are permanently attribution-only:
          nothing in this console can grant one a capability or a way to authenticate.
        </p>
      </aside>

      {pending ? (
        <ConfirmDialog action={pending} onCancel={() => setPending(null)} onConfirm={() => void runPendingAction(pending)} />
      ) : null}
    </section>
  );
}
