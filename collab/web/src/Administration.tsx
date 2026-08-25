import {
  ADMIN_DIRECTORY_MAX_RESULTS,
  ADMIN_DIRECTORY_MAX_TERM_LENGTH,
  ADMIN_DIRECTORY_MIN_TERM_LENGTH,
  ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_MAX_GROUP_LENGTH,
  APP_ROLES,
  normalizeAdminDirectorySearchTerm,
  parseAdminDirectoryGroupSearchResponse,
  parseAdminDirectoryIdentitySearchResponse,
  parseAdminRoleMappingList,
  type AdminDirectoryGroupV1,
  type AdminDirectoryIdentityV1,
  type AdminRoleMappingV1,
  type AppRole,
} from "@cd-collab/contracts/admin";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AdminPeoplePanel } from "./AdminPeoplePanel.js";
import { ComponentHealthPanel } from "./ComponentHealthPanel.js";
import { protectedApiFetch } from "./protected-api.js";

type AdminTab = "roles" | "people";

const ADMIN_TAB_PATHS: Record<AdminTab, string> = {
  roles: "/administration",
  people: "/admin/people",
};

function adminTabFromPathname(pathname: string): AdminTab {
  return pathname === "/admin/people" ? "people" : "roles";
}

const ROLE_LABELS: Record<AppRole, string> = {
  viewer: "Viewer",
  contributor: "Contributor",
  "case-lead": "Case lead",
  admin: "Administrator",
};

const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  viewer: "Read investigations available to the signed-in identity.",
  contributor: "Add notes, evidence, imports, and discussion.",
  "case-lead": "Run and lead investigations, decide, export, and manage sources.",
  admin: "Manage workspace group-role mappings in addition to case-lead capabilities.",
};

type PendingChange =
  | { kind: "set"; group: string; role: AppRole; previous: AppRole | null }
  | { kind: "revoke"; group: string; previous: AppRole };

function boundedError(response: Response, action: string): string {
  if (response.status === 400) return `${action} was rejected because the request is invalid.`;
  if (response.status === 404) return `${action} could not finish because the mapping changed. Refresh and try again.`;
  if (response.status === 503) return `${action} is temporarily unavailable. No change was confirmed.`;
  return `${action} failed. No change was confirmed.`;
}

function Confirmation(props: {
  change: PendingChange;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  const change = props.change;
  const title = change.kind === "revoke"
    ? "Revoke this group mapping?"
    : change.role === "admin"
      ? "Grant administrator access?"
      : change.previous
        ? "Update this group mapping?"
        : "Grant or replace this group mapping?";

  return (
    <div className="admin-confirm" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onCancel();
    }}>
      <section
        className="admin-confirm__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        aria-describedby="admin-confirm-copy"
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onCancel();
          if (event.key === "Tab" && !event.shiftKey && document.activeElement === confirmRef.current) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
          if (event.key === "Tab" && event.shiftKey && document.activeElement === cancelRef.current) {
            event.preventDefault();
            confirmRef.current?.focus();
          }
        }}
      >
        <h2 id="admin-confirm-title">{title}</h2>
        <p id="admin-confirm-copy">
          {change.kind === "revoke" ? (
            <>
              <code>{change.group}</code> will no longer grant the {ROLE_LABELS[change.previous]} role.
            </>
          ) : (
            <>
              <code>{change.group}</code> will grant the {ROLE_LABELS[change.role]} role
              {change.previous ? ` instead of ${ROLE_LABELS[change.previous]}` : ""}.
              {change.role === "admin"
                ? " Administrators can change workspace permissions, including other administrator mappings."
                : " Access changes take effect on the next authorized request."}
            </>
          )}
        </p>
        <div className="admin-confirm__actions">
          <button ref={cancelRef} type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} className="admin-button admin-button--danger" type="button" onClick={props.onConfirm}>
            {change.kind === "revoke" ? "Confirm revoke" : change.role === "admin" ? "Confirm administrator grant" : "Confirm update"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function Administration(props: {
  tab?: AdminTab;
  onSelectTab?: (tab: AdminTab) => void;
} = {}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const newRoleRef = useRef<HTMLSelectElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [mappings, setMappings] = useState<AdminRoleMappingV1[]>([]);
  const [mappingEdits, setMappingEdits] = useState<Record<string, AppRole>>({});
  const [mappingLimitReached, setMappingLimitReached] = useState(false);
  const [loadingMappings, setLoadingMappings] = useState(true);
  const [term, setTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [groups, setGroups] = useState<AdminDirectoryGroupV1[]>([]);
  const [identities, setIdentities] = useState<AdminDirectoryIdentityV1[]>([]);
  const [newGroup, setNewGroup] = useState("");
  const [newRole, setNewRole] = useState<AppRole>("viewer");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [uncontrolledTab, setUncontrolledTab] = useState<AdminTab>(() =>
    adminTabFromPathname(window.location.pathname),
  );
  const activeTab = props.tab ?? uncontrolledTab;

  useEffect(() => headingRef.current?.focus(), []);

  useEffect(() => {
    document.title =
      activeTab === "people"
        ? "People · Administration · ContextDesk War Room"
        : "Administration · ContextDesk War Room";
  }, [activeTab]);

  useEffect(() => {
    if (props.tab) return undefined;
    function onPopState() {
      setUncontrolledTab(adminTabFromPathname(window.location.pathname));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [props.tab]);

  function selectTab(tab: AdminTab) {
    if (props.onSelectTab) {
      props.onSelectTab(tab);
      return;
    }
    setUncontrolledTab(tab);
    if (window.location.pathname !== ADMIN_TAB_PATHS[tab]) {
      window.history.pushState(null, "", ADMIN_TAB_PATHS[tab]);
    }
  }

  const refreshMappings = useCallback(async () => {
    setLoadingMappings(true);
    try {
      const response = await protectedApiFetch("/api/authz/group-role-map");
      if (!response.ok) {
        setError(boundedError(response, "Current role mappings"));
        setMappings([]);
        setMappingEdits({});
        setMappingLimitReached(false);
        return false;
      }
      const body = parseAdminRoleMappingList(await response.json());
      setMappings(body.mappings);
      setMappingEdits(Object.fromEntries(body.mappings.map((mapping) => [mapping.group, mapping.role])));
      setMappingLimitReached(body.truncated);
      setError("");
      return true;
    } catch {
      setError("Current role mappings could not be validated. No permission data is shown.");
      setMappings([]);
      setMappingEdits({});
      setMappingLimitReached(false);
      return false;
    } finally {
      setLoadingMappings(false);
    }
  }, []);

  useEffect(() => {
    void refreshMappings();
  }, [refreshMappings]);

  async function searchDirectory(event: FormEvent) {
    event.preventDefault();
    setStatus("");
    setError("");
    const normalized = normalizeAdminDirectorySearchTerm(term);
    if (
      normalized.length < ADMIN_DIRECTORY_MIN_TERM_LENGTH ||
      normalized.length > ADMIN_DIRECTORY_MAX_TERM_LENGTH
    ) {
      setError(
        `Search for ${ADMIN_DIRECTORY_MIN_TERM_LENGTH} to ${ADMIN_DIRECTORY_MAX_TERM_LENGTH} characters.`,
      );
      return;
    }
    setSearching(true);
    const request = JSON.stringify({
      schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
      term: normalized,
    });
    try {
      const [groupResponse, identityResponse] = await Promise.all([
        protectedApiFetch("/api/admin/directory/groups/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: request,
        }),
        protectedApiFetch("/api/admin/directory/identities/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: request,
        }),
      ]);
      if (!groupResponse.ok || !identityResponse.ok) {
        setGroups([]);
        setIdentities([]);
        setError("Directory search is unavailable or the search was rejected. No directory data is shown.");
        return;
      }
      const nextGroups = parseAdminDirectoryGroupSearchResponse(await groupResponse.json());
      const nextIdentities = parseAdminDirectoryIdentitySearchResponse(await identityResponse.json());
      setGroups(nextGroups.results);
      setIdentities(nextIdentities.results);
      setTerm(normalized);
      setStatus(
        `Found ${nextGroups.results.length} group${nextGroups.results.length === 1 ? "" : "s"} and ${nextIdentities.results.length} identit${nextIdentities.results.length === 1 ? "y" : "ies"}.`,
      );
    } catch {
      setGroups([]);
      setIdentities([]);
      setError("Directory search returned data this console could not validate. No directory data is shown.");
    } finally {
      setSearching(false);
    }
  }

  function requestChange(change: PendingChange, source: HTMLElement) {
    returnFocusRef.current = source;
    if (
      change.kind === "set" &&
      change.previous === null &&
      change.role !== "admin" &&
      !mappingLimitReached
    ) {
      void applyChange(change);
      return;
    }
    setPending(change);
  }

  function closeConfirmation() {
    setPending(null);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }

  async function applyChange(change: PendingChange) {
    setPending(null);
    setError("");
    setStatus("");
    try {
      const response = await protectedApiFetch("/api/authz/group-role-map", {
        method: change.kind === "revoke" ? "DELETE" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          change.kind === "revoke"
            ? { group: change.group }
            : { group: change.group, role: change.role },
        ),
      });
      if (!response.ok) {
        setError(
          boundedError(response, change.kind === "revoke" ? "Revoke" : "Role update"),
        );
        window.setTimeout(() => errorRef.current?.focus(), 0);
        return;
      }
      let auditRecorded = false;
      try {
        const mutation = await response.json() as { audit?: unknown };
        auditRecorded = mutation.audit === "recorded";
      } catch {
        auditRecorded = false;
      }
      const refreshed = await refreshMappings();
      if (!refreshed) return;
      if (change.kind === "revoke") {
        setStatus(`Mapping for ${change.group} was revoked.`);
      } else {
        setStatus(`Mapping for ${change.group} now grants ${ROLE_LABELS[change.role]}.`);
        setNewGroup("");
      }
      if (!auditRecorded) {
        setError(
          "The mapping changed, but its audit record was not confirmed. Contact the workspace operator before relying on the change.",
        );
        window.setTimeout(() => errorRef.current?.focus(), 0);
      } else {
        window.setTimeout(() => statusRef.current?.focus(), 0);
      }
    } catch {
      setError("The role change could not reach the workspace server. No change was confirmed.");
      window.setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      if (change.kind !== "revoke") {
        window.setTimeout(() => returnFocusRef.current?.focus(), 0);
      }
    }
  }

  const existingForNew = mappings.find(
    (mapping) => mapping.group.toLowerCase() === newGroup.trim().toLowerCase(),
  );

  return (
    <section className="administration" aria-labelledby="administration-title">
      <header className="administration__masthead">
        <p className="administration__eyebrow">Workspace administration</p>
        <h2 id="administration-title" ref={headingRef} tabIndex={-1}>Administration</h2>
        <p>
          Discover directory references and explicitly map groups to ContextDesk roles. Searching
          does not create users or groups, change the directory, or grant access by itself.
        </p>
      </header>

      <div className="admin-people-tabs" role="tablist" aria-label="Administration sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "roles"}
          aria-controls="administration-roles-panel"
          id="administration-tab-roles"
          onClick={() => selectTab("roles")}
        >
          Group role mappings
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "people"}
          aria-controls="administration-people-panel"
          id="administration-tab-people"
          onClick={() => selectTab("people")}
        >
          People
        </button>
      </div>

      <div
        id="administration-people-panel"
        role="tabpanel"
        aria-labelledby="administration-tab-people"
        hidden={activeTab !== "people"}
      >
        {activeTab === "people" ? <AdminPeoplePanel /> : null}
      </div>

      <div
        id="administration-roles-panel"
        role="tabpanel"
        aria-labelledby="administration-tab-roles"
        hidden={activeTab !== "roles"}
      >
      {error ? <p ref={errorRef} tabIndex={-1} className="administration__message administration__message--error" role="alert">{error}</p> : null}
      {status ? <p ref={statusRef} tabIndex={-1} className="administration__message" role="status">{status}</p> : null}

      <ComponentHealthPanel />

      <section className="administration__panel" aria-labelledby="role-mappings-title">
        <div className="administration__panel-heading">
          <div>
            <h3 id="role-mappings-title">Current group permissions</h3>
            <p>Only these explicit destination mappings grant a workspace role.</p>
          </div>
          <button type="button" onClick={() => void refreshMappings()} disabled={loadingMappings}>
            Refresh
          </button>
        </div>
        {loadingMappings ? <p role="status">Loading current mappings…</p> : mappings.length === 0 ? (
          <p>No group-role mappings are currently visible.</p>
        ) : (
          <div className="administration__table-wrap">
            <table className="administration__table">
              <thead><tr><th scope="col">Directory group</th><th scope="col">Workspace role</th><th scope="col">Actions</th></tr></thead>
              <tbody>
                {mappings.map((mapping, index) => {
                  const selected = mappingEdits[mapping.group] ?? mapping.role;
                  const selectorId = `mapping-role-${index}`;
                  return (
                    <tr key={mapping.group}>
                      <th scope="row"><code>{mapping.group}</code></th>
                      <td>
                        <label className="sr-only" htmlFor={selectorId}>Role for {mapping.group}</label>
                        <select
                          id={selectorId}
                          value={selected}
                          onChange={(event) => setMappingEdits((current) => ({ ...current, [mapping.group]: event.target.value as AppRole }))}
                        >
                          {APP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                        </select>
                      </td>
                      <td className="administration__row-actions">
                        <button
                          type="button"
                          disabled={selected === mapping.role}
                          aria-label={`Update role for ${mapping.group}`}
                          onClick={(event) => requestChange({ kind: "set", group: mapping.group, role: selected, previous: mapping.role }, event.currentTarget)}
                        >Update</button>
                        <button
                          type="button"
                          className="admin-button--danger-text"
                          aria-label={`Revoke mapping for ${mapping.group}`}
                          onClick={(event) => requestChange({ kind: "revoke", group: mapping.group, previous: mapping.role }, event.currentTarget)}
                        >Revoke</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {mappingLimitReached ? (
          <p className="administration__limit" role="note">
            The mapping safety limit was reached. This console is not showing every mapping; use
            operator tooling before making broad changes.
          </p>
        ) : null}
      </section>

      <section className="administration__panel" aria-labelledby="directory-search-title">
        <h3 id="directory-search-title">Find directory references</h3>
        <p>
          Search returns up to {ADMIN_DIRECTORY_MAX_RESULTS} matching groups and identities from the
          configured source. Refine the term to find another result; this is not a complete directory browser.
        </p>
        <form className="administration__search" onSubmit={(event) => void searchDirectory(event)}>
          <label htmlFor="administration-directory-term">Group name, username, or display name</label>
          <div>
            <input
              id="administration-directory-term"
              value={term}
              minLength={ADMIN_DIRECTORY_MIN_TERM_LENGTH}
              maxLength={ADMIN_DIRECTORY_MAX_TERM_LENGTH}
              onChange={(event) => setTerm(event.target.value)}
            />
            <button type="submit" disabled={searching}>{searching ? "Searching…" : "Search directory"}</button>
          </div>
        </form>

        {groups.length > 0 || identities.length > 0 ? (
          <div className="administration__results">
            <section aria-labelledby="directory-groups-title">
              <h4 id="directory-groups-title">Groups</h4>
              {groups.length === 0 ? <p>No matching groups in this bounded result.</p> : (
                <ul>
                  {groups.map((group) => (
                    <li key={`${group.source}:${group.dn}`}>
                      <div><strong>{group.name}</strong><code>{group.dn}</code><span>{group.source} reference</span></div>
                      <button type="button" aria-label={`Use directory group ${group.name}`} onClick={() => {
                        setNewGroup(group.dn);
                        window.setTimeout(() => newRoleRef.current?.focus(), 0);
                      }}>Use group</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="directory-identities-title">
              <h4 id="directory-identities-title">Identities</h4>
              <p>Identity results are informational. Roles are granted to groups, never directly to a discovered identity.</p>
              {identities.length === 0 ? <p>No matching identities in this bounded result.</p> : (
                <ul>
                  {identities.map((identity) => (
                    <li key={`${identity.source}:${identity.id}`}>
                      <div><strong>{identity.displayName}</strong><span>{identity.username} · {identity.source} reference</span></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </section>

      <section className="administration__panel" aria-labelledby="grant-role-title">
        <h3 id="grant-role-title">Grant or replace a group role</h3>
        <p>Paste or select an exact directory group reference, then choose the one role it should grant.</p>
        <form className="administration__grant" onSubmit={(event) => {
          event.preventDefault();
          const group = newGroup.trim();
          if (!group) {
            setError("Choose or enter a directory group before granting a role.");
            return;
          }
          requestChange({ kind: "set", group, role: newRole, previous: existingForNew?.role ?? null }, event.currentTarget.querySelector("button[type=submit]") as HTMLButtonElement);
        }}>
          <label>Directory group<input value={newGroup} maxLength={ADMIN_ROLE_MAPPING_MAX_GROUP_LENGTH} onChange={(event) => setNewGroup(event.target.value)} /></label>
          <label>Workspace role<select ref={newRoleRef} value={newRole} onChange={(event) => setNewRole(event.target.value as AppRole)}>
            {APP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
          </select></label>
          <p className="administration__role-description">{ROLE_DESCRIPTIONS[newRole]}</p>
          <button type="submit">{existingForNew ? "Review mapping update" : "Grant role"}</button>
        </form>
      </section>

      <aside className="administration__boundary" aria-labelledby="administration-boundary-title">
        <h3 id="administration-boundary-title">Authority boundary</h3>
        <p>
          Directory results are discovered references only. This console never creates identities,
          changes directory membership, stores credentials, or treats an imported role as authority.
          Permissions come only from the persistent mappings shown above.
        </p>
      </aside>
      </div>

      {pending ? <Confirmation change={pending} onCancel={closeConfirmation} onConfirm={() => void applyChange(pending)} /> : null}
    </section>
  );
}
