import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./styles/setup-wizard.css";

type SetupStatus = {
  schemaId: "cd-collab.setup_status.v1";
  revision: number;
  phase: string;
  claimed: boolean;
  failureCode: string | null;
};

type SecretPurpose =
  | "initial_admin_password"
  | "database_url"
  | "migrate_database_url"
  | "ldap_bind_password"
  | "gateway_api_key";

type SetupError = { error?: unknown };

const ERROR_COPY: Record<string, string> = {
  invalid_owner_token: "The owner token was not accepted. Check the token and try again.",
  claim_unavailable: "Another owner has already claimed this installation.",
  stale_revision: "Setup changed in another window. Refresh the status before trying again.",
  secret_reference_unavailable: "A protected value is no longer available. Enter it again and prepare a new draft.",
  configuration_invalid: "The draft did not pass the server's bounded configuration checks. Review the highlighted stage.",
  setup_busy: "Setup is busy in another request. Wait a moment and try again.",
  setup_storage_unavailable: "The setup state could not be read safely. Check the host and try again.",
};

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCopy(status: number, body: unknown): string {
  const code =
    typeof body === "object" && body !== null && "error" in body
      ? (body as SetupError).error
      : null;
  return typeof code === "string" && ERROR_COPY[code]
    ? ERROR_COPY[code]
    : `Setup returned HTTP ${status}. Your entries are still here; review them and try again.`;
}

export function SetupWizard(props: { apiBase?: string; onUnavailable?: () => void }) {
  const apiBase = props.apiBase ?? "/api/setup";
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [ownerToken, setOwnerToken] = useState("");
  const [claimantLabel, setClaimantLabel] = useState("");
  const [deploymentLabel, setDeploymentLabel] = useState("ContextDesk War Room");
  const [profile, setProfile] = useState<"single_node" | "postgres_ldap">("single_node");
  const [dataRoot, setDataRoot] = useState("");
  const [evidenceRoot, setEvidenceRoot] = useState("");
  const [sqlitePath, setSqlitePath] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [migrateDatabaseUrl, setMigrateDatabaseUrl] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [ldapUrl, setLdapUrl] = useState("");
  const [ldapUserSearchBase, setLdapUserSearchBase] = useState("");
  const [ldapGroupSearchBase, setLdapGroupSearchBase] = useState("");
  const [ldapBindDn, setLdapBindDn] = useState("");
  const [ldapBindPassword, setLdapBindPassword] = useState("");
  const [ldapAdminGroup, setLdapAdminGroup] = useState("");
  const [gatewayEnabled, setGatewayEnabled] = useState(false);
  const [gatewayLabel, setGatewayLabel] = useState("");
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState("");
  const [gatewayProfileId, setGatewayProfileId] = useState("");
  const [gatewayModelId, setGatewayModelId] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [prepared, setPrepared] = useState(false);
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch(`${apiBase}/status`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (response.status === 404) {
          props.onUnavailable?.();
          return;
        }
        const body = await responseBody(response);
        if (!response.ok) throw new Error(errorCopy(response.status, body));
        if (active) setStatus(body as SetupStatus);
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : "Setup status is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [apiBase, props.onUnavailable]);

  const checklist = useMemo(
    () => [
      { label: "Claim this installation", done: status?.claimed === true },
      { label: "Name the deployment", done: deploymentLabel.trim().length > 0 },
      { label: profile === "single_node" ? "Choose SQLite storage" : "Connect PostgreSQL storage", done: prepared },
      { label: profile === "single_node" ? "Create the first local administrator" : "Describe LDAP sign-in", done: prepared },
      { label: gatewayEnabled ? "Describe the model gateway" : "Gateway deferred", done: prepared },
      { label: "Run bounded verification", done: verified },
    ],
    [deploymentLabel, gatewayEnabled, prepared, profile, status?.claimed, verified],
  );

  async function claim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: "cd-collab.setup_claim_request.v1",
          expectedRevision: status.revision,
          ownerToken,
          claimantLabel,
        }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(errorCopy(response.status, body));
      setStatus(body as SetupStatus);
      setMessage("Installation ownership claimed. Your token stays in this browser form and is never returned by the server.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Setup claim failed.");
    } finally {
      setPending(false);
    }
  }

  async function issueSecret(purpose: SecretPurpose, value: string): Promise<string> {
    const response = await fetch(`${apiBase}/secrets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-contextdesk-setup-token": ownerToken,
      },
      body: JSON.stringify({ purpose, value }),
    });
    const body = await responseBody(response);
    if (!response.ok) throw new Error(errorCopy(response.status, body));
    if (
      typeof body !== "object" ||
      body === null ||
      !("handle" in body) ||
      typeof (body as { handle: unknown }).handle !== "string"
    ) {
      throw new Error("The host did not return a usable protected reference.");
    }
    return (body as { handle: string }).handle;
  }

  function reference(purpose: SecretPurpose, handle: string) {
    return { kind: "handle", purpose, fileRef: null, handle };
  }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status || !status.claimed || pending) return;
    setPending(true);
    setMessage(null);
    setVerified(false);
    try {
      const handles = new Map<SecretPurpose, string>();
      if (profile === "single_node") {
        handles.set("initial_admin_password", await issueSecret("initial_admin_password", adminPassword));
      } else {
        handles.set("database_url", await issueSecret("database_url", databaseUrl));
        handles.set(
          "migrate_database_url",
          await issueSecret("migrate_database_url", migrateDatabaseUrl || databaseUrl),
        );
        if (ldapBindPassword) {
          handles.set("ldap_bind_password", await issueSecret("ldap_bind_password", ldapBindPassword));
        }
      }
      if (gatewayEnabled) {
        handles.set("gateway_api_key", await issueSecret("gateway_api_key", gatewayKey));
      }

      const revision = status.revision;
      const draft = {
        schemaId: "cd-collab.setup_deployment_draft_request.v1",
        basedOnRevision: revision,
        draftRevision: revision + 1,
        deploymentProfile: profile,
        dataRoot,
        evidenceRoot,
        storage:
          profile === "single_node"
            ? { kind: "sqlite", sqlitePath, databaseUrlRef: null, migrateDatabaseUrlRef: null }
            : {
                kind: "postgres",
                sqlitePath: null,
                databaseUrlRef: reference("database_url", handles.get("database_url") as string),
                migrateDatabaseUrlRef: reference(
                  "migrate_database_url",
                  handles.get("migrate_database_url") as string,
                ),
              },
        authentication:
          profile === "single_node"
            ? {
                kind: "local",
                local: {
                  initialAdminUsername: adminUsername,
                  initialAdminDisplayName: adminDisplayName,
                  initialAdminPasswordRef: reference(
                    "initial_admin_password",
                    handles.get("initial_admin_password") as string,
                  ),
                },
                ldap: null,
              }
            : {
                kind: "ldap",
                local: null,
                ldap: {
                  url: ldapUrl,
                  starttls: ldapUrl.startsWith("ldap:"),
                  caCertificateRef: null,
                  userDnTemplate: null,
                  userSearchBase: ldapUserSearchBase,
                  userSearchFilter: "(&(objectClass=person)(uid={username}))",
                  groupSearchBase: ldapGroupSearchBase,
                  groupSearchFilter: "(&(objectClass=groupOfNames)(member={dn}))",
                  bindDn: ldapBindDn || null,
                  bindPasswordRef: ldapBindPassword
                    ? reference("ldap_bind_password", handles.get("ldap_bind_password") as string)
                    : null,
                  adminGroup: ldapAdminGroup,
                },
              },
        gateway: gatewayEnabled
          ? {
              kind: "openai_compatible",
              profileId: gatewayProfileId,
              label: gatewayLabel,
              baseUrl: gatewayBaseUrl,
              modelId: gatewayModelId,
              apiKeyRef: reference("gateway_api_key", handles.get("gateway_api_key") as string),
            }
          : null,
      };
      const response = await fetch(`${apiBase}/draft`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-contextdesk-setup-token": ownerToken,
        },
        body: JSON.stringify({ expectedRevision: revision, deploymentLabel, draft }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(errorCopy(response.status, body));
      if (
        typeof body === "object" &&
        body !== null &&
        "status" in body
      ) {
        setStatus((body as { status: SetupStatus }).status);
      }
      setPrepared(true);
      setMessage("Configuration prepared. Nothing has been installed or restarted.");
    } catch (error) {
      setPrepared(false);
      setMessage(error instanceof Error ? error.message : "The draft could not be prepared.");
    } finally {
      setPending(false);
    }
  }

  async function verify() {
    if (!status || !prepared || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-contextdesk-setup-token": ownerToken,
        },
        body: JSON.stringify({ expectedRevision: status.revision }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(errorCopy(response.status, body));
      setVerified(true);
      setMessage(
        "Bounded configuration checks passed. External services were not contacted, and installation is not complete.",
      );
    } catch (error) {
      setVerified(false);
      setMessage(error instanceof Error ? error.message : "Verification could not run.");
    } finally {
      setPending(false);
    }
  }

  if (!status) {
    return (
      <main className="setup-wizard setup-wizard--loading">
        <p className="setup-wizard__eyebrow">First-run setup</p>
        <h1>Preparing the setup checklist…</h1>
        {message ? <p role="alert">{message}</p> : null}
      </main>
    );
  }

  return (
    <main className="setup-wizard">
      <header className="setup-wizard__hero">
        <div>
          <p className="setup-wizard__eyebrow">ContextDesk · first-run setup</p>
          <h1>Prepare your War Room in about five minutes</h1>
          <p>
            Choose storage, sign-in, and an optional model gateway. ContextDesk checks the draft without exposing protected values.
          </p>
        </div>
        <div className="setup-wizard__state" aria-label="Installation state">
          <strong>{verified ? "Configuration checked" : prepared ? "Draft prepared" : "Not configured"}</strong>
          <span>Installation is not complete</span>
        </div>
      </header>

      <div className="setup-wizard__layout">
        <aside className="setup-wizard__checklist" aria-label="Setup checklist">
          <h2>Your checklist</h2>
          <ol>
            {checklist.map((item, index) => (
              <li key={item.label} className={item.done ? "is-done" : ""}>
                <span>{item.done ? "✓" : index + 1}</span>
                {item.label}
              </li>
            ))}
          </ol>
          <p>Protected values are exchanged for host-owned references. They are never returned by setup APIs.</p>
        </aside>

        <section className="setup-wizard__content">
          {!status.claimed ? (
            <form className="setup-wizard__panel" onSubmit={(event) => void claim(event)}>
              <p className="setup-wizard__step">Step 1</p>
              <h2>Claim this installation</h2>
              <p>Use the high-entropy owner token supplied by the host. Claiming prevents another browser from preparing this installation.</p>
              <label>
                Your name or setup role
                <input value={claimantLabel} onChange={(event) => setClaimantLabel(event.target.value)} required />
              </label>
              <label>
                Owner token
                <input type="password" autoComplete="off" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} required />
              </label>
              <button type="submit" disabled={pending}>{pending ? "Claiming…" : "Claim installation"}</button>
            </form>
          ) : (
            <form className="setup-wizard__panel" onSubmit={(event) => void prepare(event)}>
              <p className="setup-wizard__step">Steps 2–5</p>
              <h2>Describe this deployment</h2>
              <div className="setup-wizard__grid">
                <label>
                  Owner token
                  <input type="password" autoComplete="off" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} required />
                </label>
                <label>
                  Deployment label
                  <input value={deploymentLabel} onChange={(event) => setDeploymentLabel(event.target.value)} required />
                </label>
                <label>
                  Deployment pattern
                  <select value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)}>
                    <option value="single_node">Single node · SQLite + local sign-in</option>
                    <option value="postgres_ldap">Team deployment · PostgreSQL + LDAP</option>
                  </select>
                </label>
                <label>
                  Data root
                  <input value={dataRoot} onChange={(event) => setDataRoot(event.target.value)} placeholder="Absolute host path" required />
                </label>
                <label>
                  Evidence root
                  <input value={evidenceRoot} onChange={(event) => setEvidenceRoot(event.target.value)} placeholder="Inside the data root" required />
                </label>
              </div>

              <fieldset>
                <legend>{profile === "single_node" ? "SQLite storage" : "PostgreSQL storage"}</legend>
                {profile === "single_node" ? (
                  <label>SQLite database path<input value={sqlitePath} onChange={(event) => setSqlitePath(event.target.value)} required /></label>
                ) : (
                  <div className="setup-wizard__grid">
                    <label>Application database URL<input type="password" value={databaseUrl} onChange={(event) => setDatabaseUrl(event.target.value)} required /></label>
                    <label>Migration database URL<input type="password" value={migrateDatabaseUrl} onChange={(event) => setMigrateDatabaseUrl(event.target.value)} placeholder="Uses application URL if blank" /></label>
                  </div>
                )}
              </fieldset>

              <fieldset>
                <legend>{profile === "single_node" ? "First local administrator" : "LDAP sign-in"}</legend>
                {profile === "single_node" ? (
                  <div className="setup-wizard__grid">
                    <label>Admin username<input value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)} required /></label>
                    <label>Display name<input value={adminDisplayName} onChange={(event) => setAdminDisplayName(event.target.value)} required /></label>
                    <label>Initial password<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} required /></label>
                  </div>
                ) : (
                  <div className="setup-wizard__grid">
                    <label>LDAP URL<input value={ldapUrl} onChange={(event) => setLdapUrl(event.target.value)} placeholder="ldaps://directory.example.test" required /></label>
                    <label>User search base<input value={ldapUserSearchBase} onChange={(event) => setLdapUserSearchBase(event.target.value)} required /></label>
                    <label>Group search base<input value={ldapGroupSearchBase} onChange={(event) => setLdapGroupSearchBase(event.target.value)} required /></label>
                    <label>Bind DN (optional)<input value={ldapBindDn} onChange={(event) => setLdapBindDn(event.target.value)} /></label>
                    <label>Bind password<input type="password" value={ldapBindPassword} onChange={(event) => setLdapBindPassword(event.target.value)} required={ldapBindDn.length > 0} /></label>
                    <label>Administrator group<input value={ldapAdminGroup} onChange={(event) => setLdapAdminGroup(event.target.value)} required /></label>
                  </div>
                )}
              </fieldset>

              <fieldset>
                <legend>Model gateway</legend>
                <label className="setup-wizard__check">
                  <input type="checkbox" checked={gatewayEnabled} onChange={(event) => setGatewayEnabled(event.target.checked)} />
                  Configure an OpenAI-compatible gateway now
                </label>
                {gatewayEnabled ? (
                  <div className="setup-wizard__grid">
                    <label>Gateway label<input value={gatewayLabel} onChange={(event) => setGatewayLabel(event.target.value)} required /></label>
                    <label>Base URL<input value={gatewayBaseUrl} onChange={(event) => setGatewayBaseUrl(event.target.value)} required /></label>
                    <label>Profile ID<input value={gatewayProfileId} onChange={(event) => setGatewayProfileId(event.target.value)} required /></label>
                    <label>Default model ID<input value={gatewayModelId} onChange={(event) => setGatewayModelId(event.target.value)} required /></label>
                    <label>API key<input type="password" value={gatewayKey} onChange={(event) => setGatewayKey(event.target.value)} required /></label>
                  </div>
                ) : <p className="setup-wizard__hint">You can prepare storage and sign-in without a gateway. AI triage will remain unavailable until a profile catalog is configured.</p>}
              </fieldset>

              <div className="setup-wizard__actions">
                <button type="submit" disabled={pending}>{pending ? "Preparing…" : "Prepare configuration"}</button>
                <button type="button" className="setup-wizard__secondary" onClick={() => void verify()} disabled={!prepared || pending}>
                  {pending && prepared ? "Checking…" : "Run bounded checks"}
                </button>
              </div>
            </form>
          )}

          {message ? <p className="setup-wizard__message" role="status" aria-live="polite">{message}</p> : null}

          <section className="setup-wizard__boundary" aria-labelledby="setup-boundary-title">
            <h2 id="setup-boundary-title">What this slice can safely do</h2>
            <div>
              <p><strong>Prepared</strong><span>Validate structure, issue protected references, and stage a process-local draft.</span></p>
              <p><strong>Checked</strong><span>Confirm bounded shape and handle integrity without contacting external systems.</span></p>
              <p><strong>Not complete</strong><span>Atomic write, connectivity proof, restart, and installation completion remain unavailable.</span></p>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
