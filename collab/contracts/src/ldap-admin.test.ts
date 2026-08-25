import { describe, expect, it } from "vitest";
import { DEFAULT_DIRECTORY_ATTRIBUTE_MAP } from "./directory-mapping.js";
import {
  LDAP_PROBE_REPORT_SCHEMA_ID,
  LDAP_PROBE_REQUEST_SCHEMA_ID,
  LDAP_PUBLIC_CONFIG_SCHEMA_ID,
  parseLdapProbeReport,
  parseLdapProbeRequest,
  parseLdapPublicConfig,
  parseLdapUserResolutionModes,
  projectLdapProbeReady,
} from "./ldap-admin.js";
import { ContractViolation } from "./parse.js";

const publicConfig = {
  schemaId: LDAP_PUBLIC_CONFIG_SCHEMA_ID,
  authMode: "ldap" as const,
  url: "ldaps://directory.example.test:636",
  starttls: false,
  verifyTls: true,
  caConfigured: false,
  userResolutionModes: ["service_bind_search", "upn", "domain_backslash"],
  userDnTemplate: null,
  userSearchBase: "ou=people,dc=example,dc=test",
  userSearchFilter: "(uid={username})",
  groupSearchBase: "ou=groups,dc=example,dc=test",
  groupSearchFilter: "(&(objectClass=groupOfNames)(member={dn}))",
  memberAttribute: "memberOf",
  bindDn: "cn=svc,ou=services,dc=example,dc=test",
  bindPasswordConfigured: true,
  upnSuffix: "example.test",
  netbiosDomain: "EXAMPLE",
  attributeMap: DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  timeoutMs: 8000,
};

describe("LDAP admin contracts", () => {
  it("parses a share-safe public config and refuses secrets", () => {
    expect(parseLdapPublicConfig(publicConfig).bindPasswordConfigured).toBe(true);
    expect(() =>
      parseLdapPublicConfig({
        ...publicConfig,
        bindPassword: "fixture-bind-secret",
      }),
    ).toThrow(ContractViolation);
    expect(() => parseLdapPublicConfig({ ...publicConfig, authMode: "local" })).toThrow(
      /live directory URL/,
    );
  });

  it("accepts local auth with no directory URL", () => {
    expect(
      parseLdapPublicConfig({
        ...publicConfig,
        authMode: "local",
        url: null,
        userResolutionModes: [],
        bindPasswordConfigured: false,
        bindDn: null,
      }).authMode,
    ).toBe("local");
  });

  it("parses probe requests without copying secrets into reports", () => {
    const request = parseLdapProbeRequest({
      schemaId: LDAP_PROBE_REQUEST_SCHEMA_ID,
      probeUsername: "alice",
      probePassword: "fixture-alice-secret",
    });
    expect(request.probeUsername).toBe("alice");
    const stages = [
      { id: "transport", status: "passed", detail: "Encrypted directory transport is available." },
      { id: "service_bind", status: "passed", detail: "Service bind succeeded." },
      { id: "user_search", status: "passed", detail: "Probe user resolved and authenticated." },
      { id: "group_lookup", status: "passed", detail: "Found 1 group reference(s)." },
      { id: "role_map", status: "passed", detail: "At least one probe group maps to a workspace role." },
    ] as const;
    const report = parseLdapProbeReport({
      schemaId: LDAP_PROBE_REPORT_SCHEMA_ID,
      ready: projectLdapProbeReady(stages),
      stages,
      bindPasswordConfigured: true,
      groupsFound: 1,
      mappedRoles: true,
    });
    expect(report.ready).toBe(true);
    expect(JSON.stringify(report)).not.toContain("fixture-alice-secret");
    expect(() =>
      parseLdapProbeReport({
        ...report,
        stages: report.stages.map((stage) => ({
          ...stage,
          detail: "used probePassword during bind",
        })),
      }),
    ).toThrow(/must not carry secrets/);
  });

  it("requires unique resolution modes and explicit companion fields", () => {
    expect(parseLdapUserResolutionModes(["upn", "domain_backslash"])).toEqual([
      "upn",
      "domain_backslash",
    ]);
    expect(() => parseLdapUserResolutionModes(["upn", "upn"])).toThrow(/duplicate/);
    expect(() => parseLdapUserResolutionModes(["kerberos"])).toThrow(/unknown/);
  });
});
