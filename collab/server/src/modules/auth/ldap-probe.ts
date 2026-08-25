import {
  LDAP_PROBE_REPORT_SCHEMA_ID,
  LDAP_PROBE_STAGES,
  parseLdapProbeReport,
  projectLdapProbeReady,
  type AppRole,
  type LdapProbeReportV1,
  type LdapProbeStageV1,
} from "@cd-collab/contracts";
import { LdapAuthAdapter } from "./ldap-adapter.js";
import type { LdapConfig } from "./ldap-config.js";
import { createLiveLdapFactory } from "./ldap-live.js";
import { parseLoginName } from "./ldap-resolution.js";
import {
  DirectoryClaimsUnsafeError,
  LdapBindError,
  LdapTimeoutError,
  LdapTlsError,
  LdapUnavailableError,
  type LdapSessionFactory,
} from "./ldap-session.js";
import { createAuthLog } from "./log.js";

export interface LdapProbeInput {
  config: LdapConfig | null;
  authMode: "ldap" | "local";
  probeUsername: string | null;
  probePassword: string | null;
  resolveRoles: (groups: readonly string[]) => AppRole[];
  roleMapConfigured: boolean;
  sessions?: LdapSessionFactory;
}

function scrub(detail: string, secrets: readonly string[]): string {
  let out = detail;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 240);
}

function stage(
  id: LdapProbeStageV1["id"],
  status: LdapProbeStageV1["status"],
  detail: string,
  secrets: readonly string[],
): LdapProbeStageV1 {
  return { id, status, detail: scrub(detail, secrets) || "no detail" };
}

function report(
  stages: LdapProbeStageV1[],
  bindPasswordConfigured: boolean,
  groupsFound: number,
  mappedRoles: boolean,
): LdapProbeReportV1 {
  const ordered = LDAP_PROBE_STAGES.map((id) => {
    const found = stages.find((item) => item.id === id);
    return found ?? { id, status: "not_run" as const, detail: "Stage did not run." };
  });
  return parseLdapProbeReport({
    schemaId: LDAP_PROBE_REPORT_SCHEMA_ID,
    ready: projectLdapProbeReady(ordered),
    stages: ordered,
    bindPasswordConfigured,
    groupsFound: Math.min(Math.max(0, groupsFound), 50),
    mappedRoles,
  });
}

export async function probeLdap(input: LdapProbeInput): Promise<LdapProbeReportV1> {
  const secrets = [input.probePassword ?? "", input.config?.bindPassword ?? ""].filter(
    (value) => value.length > 0,
  );
  if (input.authMode !== "ldap" || !input.config) {
    const stages = LDAP_PROBE_STAGES.map((id) =>
      stage(id, "skipped", "This installation is not using LDAP authentication.", secrets),
    );
    return report(stages, false, 0, false);
  }

  const config = input.config;
  const factory = input.sessions ?? createLiveLdapFactory(config);
  const client = factory();
  const stages: LdapProbeStageV1[] = [];
  let groupsFound = 0;
  let mappedRoles = false;
  try {
    try {
      await client.handshake();
      stages.push(stage("transport", "passed", "Encrypted directory transport is available.", secrets));
    } catch (err) {
      const detail =
        err instanceof LdapTimeoutError
          ? "Directory transport timed out."
          : err instanceof LdapTlsError
            ? "TLS verification failed."
            : "Directory transport failed.";
      return report(
        [
          stage("transport", "failed", detail, secrets),
          stage("service_bind", "not_run", "Transport did not succeed.", secrets),
          stage("user_search", "not_run", "Transport did not succeed.", secrets),
          stage("group_lookup", "not_run", "Transport did not succeed.", secrets),
          stage("role_map", "not_run", "Transport did not succeed.", secrets),
        ],
        Boolean(config.bindDn && config.bindPassword),
        0,
        false,
      );
    }

    if (!config.bindDn || !config.bindPassword) {
      stages.push(
        stage(
          "service_bind",
          "skipped",
          "No service bind is configured.",
          secrets,
        ),
      );
    } else {
      try {
        await client.bind(config.bindDn, config.bindPassword);
        stages.push(stage("service_bind", "passed", "Service bind succeeded.", secrets));
      } catch (err) {
        const detail =
          err instanceof LdapTimeoutError
            ? "Service bind timed out."
            : err instanceof LdapBindError
              ? "Service bind was rejected."
              : "Service bind failed.";
        stages.push(stage("service_bind", "failed", detail, secrets));
      }
    }

    const adapter = new LdapAuthAdapter(config, createAuthLog(), factory);
    if (!input.probeUsername) {
      stages.push(
        stage(
          "user_search",
          "skipped",
          "No probe username was supplied.",
          secrets,
        ),
      );
    } else if (!parseLoginName(input.probeUsername).ok) {
      stages.push(
        stage("user_search", "failed", "Probe username is not a supported login form.", secrets),
      );
    } else if (input.probePassword) {
      try {
        const result = await adapter.authenticate(input.probeUsername, input.probePassword);
        if (!result) {
          stages.push(
            stage(
              "user_search",
              "failed",
              "Probe user could not be resolved or the directory rejected the bind.",
              secrets,
            ),
          );
        } else {
          groupsFound = result.groups.length;
          mappedRoles = input.resolveRoles(result.groups).length > 0;
          stages.push(stage("user_search", "passed", "Probe user resolved and authenticated.", secrets));
          stages.push(
            stage(
              "group_lookup",
              result.groups.length > 0 ? "passed" : "failed",
              result.groups.length > 0
                ? `Found ${result.groups.length} group reference(s).`
                : "No groups were visible for the probe user.",
              secrets,
            ),
          );
        }
      } catch (err) {
        const detail =
          err instanceof DirectoryClaimsUnsafeError
            ? "Directory claims for the probe user are unsafe."
            : err instanceof LdapTimeoutError
              ? "Probe user authentication timed out."
              : "Probe user authentication failed.";
        stages.push(stage("user_search", "failed", detail, secrets));
      }
    } else {
      try {
        const parsed = parseLoginName(input.probeUsername);
        const term = parsed.ok ? parsed.username : input.probeUsername;
        const identities = await adapter.searchIdentities(term, {
          limit: 2,
          timeoutMs: Math.min(config.timeoutMs, 3_000),
        });
        if (identities.length === 1) {
          stages.push(
            stage("user_search", "passed", "Probe username matched exactly one directory identity.", secrets),
          );
        } else if (identities.length > 1) {
          stages.push(stage("user_search", "failed", "Probe username is ambiguous.", secrets));
        } else {
          stages.push(stage("user_search", "failed", "Probe username was not found.", secrets));
        }
      } catch (err) {
        const detail =
          err instanceof LdapUnavailableError ? "Directory search is inaccessible." : "User search failed.";
        stages.push(stage("user_search", "failed", detail, secrets));
      }
    }

    if (!stages.some((item) => item.id === "group_lookup")) {
      if (config.groupSearchBase) {
        try {
          await adapter.searchDirectoryGroups("c", {
            limit: 20,
            timeoutMs: Math.min(config.timeoutMs, 3_000),
          });
          stages.push(stage("group_lookup", "passed", "Group search base is reachable.", secrets));
        } catch (err) {
          const detail =
            err instanceof LdapUnavailableError ? "Group lookup is inaccessible." : "Group lookup failed.";
          stages.push(stage("group_lookup", "failed", detail, secrets));
        }
      } else if (config.memberAttribute) {
        stages.push(
          stage(
            "group_lookup",
            "skipped",
            "Group search is not configured; membership uses the member attribute at login.",
            secrets,
          ),
        );
      } else {
        stages.push(
          stage("group_lookup", "failed", "No group search base or member attribute is configured.", secrets),
        );
      }
    }

    if (input.probeUsername && input.probePassword && stages.some((item) => item.id === "user_search" && item.status === "passed")) {
      stages.push(
        stage(
          "role_map",
          mappedRoles ? "passed" : "failed",
          mappedRoles
            ? "At least one probe group maps to a workspace role."
            : "Probe groups are unmapped; sign-in would be denied.",
          secrets,
        ),
      );
    } else {
      mappedRoles = input.roleMapConfigured;
      stages.push(
        stage(
          "role_map",
          input.roleMapConfigured ? "passed" : "failed",
          input.roleMapConfigured
            ? "A group-to-role map is present."
            : "No group-to-role mappings are configured; sign-in is default-deny.",
          secrets,
        ),
      );
    }

    return report(
      stages,
      Boolean(config.bindDn && config.bindPassword),
      groupsFound,
      mappedRoles,
    );
  } finally {
    try {
      await client.unbind();
    } catch {
      // ignore
    }
  }
}
