import {
  LDAP_PROBE_REQUEST_SCHEMA_ID,
  parseLdapProbeReport,
  parseLdapPublicConfig,
  type LdapProbeReportV1,
  type LdapProbeStageV1,
  type LdapPublicConfigV1,
} from "@cd-collab/contracts/admin";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { protectedApiFetch } from "./protected-api.js";

const STAGE_LABELS: Record<LdapProbeStageV1["id"], string> = {
  transport: "Encrypted transport",
  service_bind: "Service bind",
  user_search: "User search",
  group_lookup: "Group lookup",
  role_map: "Role-map readiness",
};

function stageClass(status: LdapProbeStageV1["status"]): string {
  return `admin-ldap__stage admin-ldap__stage--${status}`;
}

export function AdminLdapPanel() {
  const [config, setConfig] = useState<LdapPublicConfigV1 | null>(null);
  const [report, setReport] = useState<LdapProbeReportV1 | null>(null);
  const [probeUsername, setProbeUsername] = useState("");
  const [probePassword, setProbePassword] = useState("");
  const [loading, setLoading] = useState(true);
  // Distinguishes the first read (nothing to show yet) from a reload of an
  // already-rendered panel, which must stay on screen while it refreshes.
  const [firstLoad, setFirstLoad] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const loadConfig = useCallback(async () => {
    setLoading(true);
    // A directory test describes the configuration it ran against. Re-reading
    // the configuration can change that, so drop the previous report rather
    // than let a stale "ready" be read as a verdict on the new values.
    setReport(null);
    try {
      const response = await protectedApiFetch("/api/admin/ldap/config");
      if (!response.ok) {
        setError(
          response.status === 403
            ? "Directory configuration requires the admin:system_config capability."
            : "Directory configuration could not be loaded.",
        );
        setConfig(null);
        return;
      }
      setConfig(parseLdapPublicConfig(await response.json()));
      setError("");
    } catch {
      setError("Directory configuration could not be loaded.");
      setConfig(null);
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  async function runProbe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (testing) return;
    setTesting(true);
    setError("");
    try {
      const response = await protectedApiFetch("/api/admin/ldap/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: LDAP_PROBE_REQUEST_SCHEMA_ID,
          probeUsername: probeUsername.trim() || null,
          probePassword: probeUsername.trim() && probePassword.length > 0 ? probePassword : null,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError("The directory test could not run. No stored secret was returned.");
        setReport(null);
        return;
      }
      setReport(parseLdapProbeReport(body));
    } catch {
      setError("The directory test could not run. No stored secret was returned.");
      setReport(null);
    } finally {
      setTesting(false);
      setProbePassword("");
    }
  }

  if (firstLoad) {
    return <p role="status">Loading directory configuration…</p>;
  }

  return (
    <div className="admin-ldap">
      {error ? (
        <p className="administration__message administration__message--error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="administration__panel" aria-labelledby="admin-ldap-config-title">
        <h3 id="admin-ldap-config-title">Current directory configuration</h3>
        <p>
          This view never shows a bind password, probe password, or other secret. Changes to
          transport and bind settings are operator-owned environment or first-run draft values,
          not a save-to-directory form.
        </p>
        <div className="admin-ldap__actions">
          <button type="button" onClick={() => void loadConfig()} disabled={loading}>
            {loading ? "Reloading…" : "Reload configuration"}
          </button>
          <span className="admin-ldap__hint">
            Re-reads the operator-owned values this server is running with. Any previous test
            report is cleared, because it described the configuration read before.
          </span>
        </div>
        {config ? (
          <dl className="admin-ldap__facts">
            <div>
              <dt>Authentication</dt>
              <dd>{config.authMode === "ldap" ? "LDAP" : "Local (directory probe skipped)"}</dd>
            </div>
            <div>
              <dt>URL</dt>
              <dd>
                <code>{config.url ?? "not configured"}</code>
              </dd>
            </div>
            <div>
              <dt>Transport</dt>
              <dd>
                {config.starttls ? "StartTLS" : config.url?.startsWith("ldaps:") ? "LDAPS" : "not configured"}
                {config.verifyTls ? " · verified TLS" : " · TLS verification disabled (fixture only)"}
              </dd>
            </div>
            <div>
              <dt>User resolution</dt>
              <dd>
                {config.userResolutionModes.length > 0
                  ? config.userResolutionModes.join(", ")
                  : "none"}
              </dd>
            </div>
            <div>
              <dt>User DN template</dt>
              <dd>
                <code>{config.userDnTemplate ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>User search base</dt>
              <dd>
                <code>{config.userSearchBase ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>User search filter</dt>
              <dd>
                <code>{config.userSearchFilter ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>Group search</dt>
              <dd>
                <code>{config.groupSearchBase ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>Member attribute</dt>
              <dd>
                <code>{config.memberAttribute ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>Service bind DN</dt>
              <dd>
                <code>{config.bindDn ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>Bind secret</dt>
              <dd>{config.bindPasswordConfigured ? "configured (not displayed)" : "not configured"}</dd>
            </div>
            <div>
              <dt>Group refresh</dt>
              <dd>
                {config.authMode !== "ldap"
                  ? "not applicable"
                  : config.bindPasswordConfigured
                    ? "live — the service bind re-reads membership on each request"
                    : "login-time snapshot — membership changes apply at next sign-in"}
              </dd>
            </div>
            <div>
              <dt>Trusted CA</dt>
              <dd>
                {config.caConfigured
                  ? "operator-supplied CA (replaces the system trust store)"
                  : "system trust store"}
              </dd>
            </div>
            <div>
              <dt>UPN suffix</dt>
              <dd>
                <code>{config.upnSuffix ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>NetBIOS domain</dt>
              <dd>
                <code>{config.netbiosDomain ?? "not set"}</code>
              </dd>
            </div>
            <div>
              <dt>Attribute map</dt>
              <dd>
                display {config.attributeMap.attributes.displayName}, title{" "}
                {config.attributeMap.attributes.roleTitle}, team {config.attributeMap.attributes.team},
                email {config.attributeMap.attributes.contactEmail}
              </dd>
            </div>
          </dl>
        ) : (
          <p>No share-safe directory configuration is available.</p>
        )}
      </section>

      <section className="administration__panel" aria-labelledby="admin-ldap-test-title">
        <h3 id="admin-ldap-test-title">Test directory connectivity</h3>
        <p>
          Stages distinguish transport, service bind, user search, group lookup, and role-map
          readiness. An optional probe username confirms search; a probe password is used once to
          confirm a user bind and is never stored.
        </p>
        <form className="admin-ldap__probe" onSubmit={(event) => void runProbe(event)}>
          <label>
            Probe username
            <input
              autoComplete="off"
              value={probeUsername}
              maxLength={128}
              onChange={(event) => setProbeUsername(event.target.value)}
            />
          </label>
          <label>
            Probe password (optional, never stored)
            <input
              type="password"
              autoComplete="new-password"
              value={probePassword}
              onChange={(event) => setProbePassword(event.target.value)}
            />
          </label>
          <button type="submit" disabled={testing}>
            {testing ? "Testing…" : "Test directory"}
          </button>
        </form>
      </section>

      {report ? (
        <section className="administration__panel" aria-labelledby="admin-ldap-report-title">
          <h3 id="admin-ldap-report-title">Last test report</h3>
          <p role="status">
            {report.ready
              ? "Every required stage passed or was skipped."
              : "The directory is not ready for sign-in with the current configuration."}
          </p>
          <ol className="admin-ldap__stages">
            {report.stages.map((stage) => (
              <li key={stage.id} className={stageClass(stage.status)}>
                <strong>{STAGE_LABELS[stage.id]}</strong>
                <span>{stage.status.replace("_", " ")}</span>
                <p>{stage.detail}</p>
              </li>
            ))}
          </ol>
          <p>
            Bind secret {report.bindPasswordConfigured ? "is configured" : "is not configured"}.
            Groups found: {report.groupsFound}. Role map {report.mappedRoles ? "has a mapped role" : "is not ready"}.
          </p>
        </section>
      ) : null}
    </div>
  );
}
