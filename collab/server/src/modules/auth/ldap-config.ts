/**
 * LDAP transport and identity-resolution config.
 * Plaintext is refused at load time. Bind secrets stay in this module.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  assertLdapAttributeName,
  assertLdapNetbiosDomain,
  assertLdapUpnSuffix,
  parseDirectoryAttributeMap,
  parseLdapUserResolutionModes,
  type DirectoryAttributeMapV1,
  type LdapPublicConfigV1,
  type LdapUserResolutionMode,
} from "@cd-collab/contracts";
import type { SetupLdapAuthenticationV1 } from "@cd-collab/contracts/setup";
import type { GroupRefreshMode } from "./adapter.js";

export const LDAP_MIN_TIMEOUT_MS = 100;
export const LDAP_MAX_TIMEOUT_MS = 30_000;
export const LDAP_DEFAULT_TIMEOUT_MS = 8_000;
const BIND_SECRET_MAX_BYTES = 16 * 1024;
const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]*-----END CERTIFICATE-----/u;

export interface LdapConfig {
  url: string;
  starttls: boolean;
  verifyTls: boolean;
  ca: string | undefined;
  userDnTemplate: string | undefined;
  userSearchBase: string | undefined;
  userSearchFilter: string;
  groupSearchBase: string | undefined;
  groupSearchFilter: string;
  memberAttribute: string | undefined;
  bindDn: string | undefined;
  /** Memory-only; never logged. */
  bindPassword: string | undefined;
  timeoutMs: number;
  groupRefreshMode: GroupRefreshMode;
  userResolutionModes: LdapUserResolutionMode[];
  upnSuffix: string | undefined;
  netbiosDomain: string | undefined;
  attributeMap: DirectoryAttributeMapV1;
}

function requireUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("COLLAB_LDAP_URL is not a valid URL");
  }
  return parsed;
}

function assertEncryptedTransport(parsed: URL, starttls: boolean): void {
  if (parsed.protocol === "ldap:" && !starttls) {
    throw new Error(
      "plaintext LDAP refused: use ldaps:// or ldap:// with COLLAB_LDAP_STARTTLS=1",
    );
  }
  if (parsed.protocol !== "ldaps:" && parsed.protocol !== "ldap:") {
    throw new Error(`unsupported LDAP URL scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("LDAP URL must not carry credentials, query, or fragment");
  }
}

function clampTimeout(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? `${LDAP_DEFAULT_TIMEOUT_MS}`, 10);
  if (!Number.isFinite(parsed)) return LDAP_DEFAULT_TIMEOUT_MS;
  return Math.max(LDAP_MIN_TIMEOUT_MS, Math.min(LDAP_MAX_TIMEOUT_MS, parsed));
}

function parseGroupRefreshMode(
  raw: string | undefined,
  hasServiceBind: boolean,
): GroupRefreshMode {
  const mode = raw?.trim() || (hasServiceBind ? "live" : "login_snapshot");
  if (mode !== "live" && mode !== "login_snapshot") {
    throw new Error(
      "COLLAB_LDAP_GROUP_REFRESH_MODE must be live or login_snapshot",
    );
  }
  if (mode === "live" && !hasServiceBind) {
    throw new Error(
      "COLLAB_LDAP_GROUP_REFRESH_MODE=live requires a service bind",
    );
  }
  return mode;
}

function readBindSecretFile(path: string): string {
  let body: string;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength < 1 || bytes.byteLength > BIND_SECRET_MAX_BYTES) {
      throw new Error("LDAP bind password file is unreadable");
    }
    body = bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
  } catch {
    throw new Error("LDAP bind password file is unreadable");
  }
  if (!body || body.includes("\0")) {
    throw new Error("LDAP bind password file is unreadable");
  }
  return body;
}

function loadBindPassword(env: NodeJS.ProcessEnv): string | undefined {
  const inline = env.COLLAB_LDAP_BIND_PASSWORD;
  const file = env.COLLAB_LDAP_BIND_PASSWORD_FILE?.trim();
  const ref = env.COLLAB_LDAP_BIND_PASSWORD_REF?.trim();
  const sources = [Boolean(inline), Boolean(file), Boolean(ref)].filter(Boolean).length;
  if (sources > 1) {
    throw new Error("LDAP bind password sources conflict; configure exactly one");
  }
  if (inline) return inline;
  if (file) return readBindSecretFile(file);
  if (ref) {
    if (!ref.startsWith("file:") || ref.includes("://")) {
      throw new Error("LDAP bind password reference must be a file: path");
    }
    const refPath = ref.slice("file:".length);
    // AGENTS.md: an owner-local secret reference is an *absolute* file: path.
    // A relative one resolves against the server process CWD, which differs
    // between a systemd unit, a container, and a developer shell - so the same
    // configuration would silently read a different file, or none.
    if (!isAbsolute(refPath)) {
      throw new Error("LDAP bind password reference must be an absolute file: path");
    }
    return readBindSecretFile(refPath);
  }
  return undefined;
}

/**
 * Trust anchors for the directory connection, as PEM *content* (not a path).
 *
 * Node treats `tls.ConnectionOptions.ca` as a replacement for its default root
 * store and silently accepts any string, so an unparsable value - a filesystem
 * path, or an empty `COLLAB_LDAP_CA=` line - yields an empty trust store and
 * turns every LDAPS/StartTLS handshake into an opaque verification failure.
 * Refuse that at load time. To *add* an internal CA to the system trust store
 * instead of replacing it, leave this unset and start Node with
 * NODE_EXTRA_CA_CERTS=/path/to/ca.pem.
 */
function loadTrustAnchors(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.COLLAB_LDAP_CA;
  if (raw === undefined) return undefined;
  const value = raw.trim();
  // A blank value is "not configured", matching the other optional settings.
  if (!value) return undefined;
  if (!PEM_CERTIFICATE.test(value)) {
    throw new Error(
      "COLLAB_LDAP_CA must be PEM certificate content, not a file path; " +
        "use NODE_EXTRA_CA_CERTS to add a CA to the system trust store",
    );
  }
  return value;
}

function optionalAttr(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  try {
    assertLdapAttributeName(raw, name);
  } catch {
    throw new Error(`${name} is not a bounded LDAP attribute name`);
  }
  return raw;
}

function deriveResolutionModes(config: {
  userDnTemplate: string | undefined;
  userSearchBase: string | undefined;
  upnSuffix: string | undefined;
  netbiosDomain: string | undefined;
}): LdapUserResolutionMode[] {
  const modes: LdapUserResolutionMode[] = [];
  if (config.userSearchBase) modes.push("service_bind_search");
  if (config.userDnTemplate) modes.push("dn_template");
  if (config.upnSuffix) modes.push("upn");
  if (config.netbiosDomain) modes.push("domain_backslash");
  return modes;
}

function parseResolutionModes(
  raw: string | undefined,
  derived: LdapUserResolutionMode[],
): LdapUserResolutionMode[] {
  if (!raw?.trim()) return derived;
  const tokens = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  try {
    return parseLdapUserResolutionModes(tokens, "COLLAB_LDAP_USER_RESOLUTION");
  } catch {
    throw new Error("COLLAB_LDAP_USER_RESOLUTION is not a unique list of known modes");
  }
}

function assertModeCompanions(config: LdapConfig): void {
  for (const mode of config.userResolutionModes) {
    if (mode === "dn_template" && !config.userDnTemplate) {
      throw new Error("DN-template resolution requires COLLAB_LDAP_USER_DN_TEMPLATE");
    }
    if (mode === "service_bind_search" && !config.userSearchBase) {
      throw new Error("service-bind search requires COLLAB_LDAP_USER_SEARCH_BASE");
    }
    if (mode === "upn") {
      if (!config.upnSuffix) throw new Error("UPN resolution requires COLLAB_LDAP_UPN_SUFFIX");
      if (!config.userSearchBase) {
        throw new Error("UPN resolution requires COLLAB_LDAP_USER_SEARCH_BASE");
      }
    }
    if (mode === "domain_backslash") {
      if (!config.netbiosDomain) {
        throw new Error("DOMAIN\\user resolution requires COLLAB_LDAP_NETBIOS_DOMAIN");
      }
      if (!config.userSearchBase) {
        throw new Error("DOMAIN\\user resolution requires COLLAB_LDAP_USER_SEARCH_BASE");
      }
    }
  }
  if (config.userResolutionModes.length === 0) {
    throw new Error("LDAP user DN template, search base, or explicit UPN/NetBIOS resolution is required");
  }
  if ((config.bindDn === undefined) !== (config.bindPassword === undefined)) {
    throw new Error("LDAP bind DN and bind password must be supplied together");
  }
}

export function loadLdapConfig(env: NodeJS.ProcessEnv = process.env): LdapConfig {
  const url = env.COLLAB_LDAP_URL;
  if (!url) {
    throw new Error("missing COLLAB_LDAP_URL");
  }
  const parsed = requireUrl(url);
  const starttls = env.COLLAB_LDAP_STARTTLS === "1";
  assertEncryptedTransport(parsed, starttls);
  const insecure = env.COLLAB_LDAP_TLS_INSECURE === "1";
  const devMode = env.COLLAB_LDAP_DEV_MODE === "1";
  if (insecure && !devMode) {
    throw new Error(
      "COLLAB_LDAP_TLS_INSECURE requires explicit COLLAB_LDAP_DEV_MODE=1",
    );
  }
  const upnSuffix = env.COLLAB_LDAP_UPN_SUFFIX?.trim() || undefined;
  const netbiosDomain = env.COLLAB_LDAP_NETBIOS_DOMAIN?.trim() || undefined;
  if (upnSuffix) {
    try {
      assertLdapUpnSuffix(upnSuffix, "COLLAB_LDAP_UPN_SUFFIX");
    } catch {
      throw new Error("COLLAB_LDAP_UPN_SUFFIX must be an explicit DNS-shaped suffix");
    }
  }
  if (netbiosDomain) {
    try {
      assertLdapNetbiosDomain(netbiosDomain, "COLLAB_LDAP_NETBIOS_DOMAIN");
    } catch {
      throw new Error("COLLAB_LDAP_NETBIOS_DOMAIN must be an explicit NetBIOS name");
    }
  }
  const memberAttribute = env.COLLAB_LDAP_MEMBER_ATTR?.trim() || undefined;
  if (memberAttribute) {
    try {
      assertLdapAttributeName(memberAttribute, "COLLAB_LDAP_MEMBER_ATTR");
    } catch {
      throw new Error("COLLAB_LDAP_MEMBER_ATTR is not a bounded LDAP attribute name");
    }
  }
  const attributeMap = parseDirectoryAttributeMap({
    schemaId: DEFAULT_DIRECTORY_ATTRIBUTE_MAP.schemaId,
    attributes: {
      displayName: optionalAttr(
        env,
        "COLLAB_LDAP_ATTR_DISPLAY_NAME",
        DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.displayName,
      ),
      roleTitle: optionalAttr(
        env,
        "COLLAB_LDAP_ATTR_ROLE_TITLE",
        DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.roleTitle,
      ),
      team: optionalAttr(
        env,
        "COLLAB_LDAP_ATTR_TEAM",
        DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.team,
      ),
      contactEmail: optionalAttr(
        env,
        "COLLAB_LDAP_ATTR_EMAIL",
        DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.contactEmail,
      ),
    },
  });
  const userDnTemplate = env.COLLAB_LDAP_USER_DN_TEMPLATE;
  const userSearchBase = env.COLLAB_LDAP_USER_SEARCH_BASE;
  const derived = deriveResolutionModes({
    userDnTemplate,
    userSearchBase,
    upnSuffix,
    netbiosDomain,
  });
  const bindPassword = loadBindPassword(env);
  const config: LdapConfig = {
    url,
    starttls,
    verifyTls: !insecure,
    ca: loadTrustAnchors(env),
    userDnTemplate,
    userSearchBase,
    userSearchFilter: env.COLLAB_LDAP_USER_SEARCH_FILTER ?? "(uid={username})",
    groupSearchBase: env.COLLAB_LDAP_GROUP_SEARCH_BASE,
    groupSearchFilter:
      env.COLLAB_LDAP_GROUP_SEARCH_FILTER ??
      "(&(objectClass=groupOfNames)(member={dn}))",
    memberAttribute,
    bindDn: env.COLLAB_LDAP_BIND_DN,
    bindPassword,
    timeoutMs: clampTimeout(env.COLLAB_LDAP_TIMEOUT_MS),
    groupRefreshMode: parseGroupRefreshMode(
      env.COLLAB_LDAP_GROUP_REFRESH_MODE,
      Boolean(env.COLLAB_LDAP_BIND_DN && bindPassword),
    ),
    userResolutionModes: parseResolutionModes(env.COLLAB_LDAP_USER_RESOLUTION, derived),
    upnSuffix,
    netbiosDomain,
    attributeMap,
  };
  assertModeCompanions(config);
  return config;
}

export function ldapConfigFromSetup(
  ldap: SetupLdapAuthenticationV1,
  bindPassword: string | undefined,
): LdapConfig {
  const parsed = requireUrl(ldap.url);
  assertEncryptedTransport(parsed, ldap.starttls);
  const attributeMap = parseDirectoryAttributeMap({
    schemaId: DEFAULT_DIRECTORY_ATTRIBUTE_MAP.schemaId,
    attributes: {
      displayName: ldap.displayNameAttr ?? DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.displayName,
      roleTitle: ldap.roleTitleAttr ?? DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.roleTitle,
      team: ldap.teamAttr ?? DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.team,
      contactEmail: ldap.emailAttr ?? DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes.contactEmail,
    },
  });
  const derived = deriveResolutionModes({
    userDnTemplate: ldap.userDnTemplate ?? undefined,
    userSearchBase: ldap.userSearchBase ?? undefined,
    upnSuffix: ldap.upnSuffix ?? undefined,
    netbiosDomain: ldap.netbiosDomain ?? undefined,
  });
  const config: LdapConfig = {
    url: ldap.url,
    starttls: ldap.starttls,
    verifyTls: true,
    ca: undefined,
    userDnTemplate: ldap.userDnTemplate ?? undefined,
    userSearchBase: ldap.userSearchBase ?? undefined,
    userSearchFilter: ldap.userSearchFilter,
    groupSearchBase: ldap.groupSearchBase,
    groupSearchFilter: ldap.groupSearchFilter,
    memberAttribute: ldap.memberAttribute ?? undefined,
    bindDn: ldap.bindDn ?? undefined,
    bindPassword,
    timeoutMs: LDAP_DEFAULT_TIMEOUT_MS,
    groupRefreshMode: parseGroupRefreshMode(
      undefined,
      Boolean(ldap.bindDn && bindPassword),
    ),
    userResolutionModes: ldap.userResolutionModes
      ? [...ldap.userResolutionModes]
      : derived.length > 0
        ? derived
        : (["service_bind_search"] satisfies LdapUserResolutionMode[]),
    upnSuffix: ldap.upnSuffix ?? undefined,
    netbiosDomain: ldap.netbiosDomain ?? undefined,
    attributeMap,
  };
  assertModeCompanions(config);
  return config;
}

export function publicLdapConfig(
  config: LdapConfig | null,
  authMode: "ldap" | "local",
): LdapPublicConfigV1 {
  return {
    schemaId: "cd-collab.ldap_public_config.v1",
    authMode,
    url: config?.url ?? null,
    starttls: config?.starttls ?? false,
    verifyTls: config?.verifyTls ?? true,
    caConfigured: Boolean(config?.ca),
    userResolutionModes: config?.userResolutionModes ?? [],
    userDnTemplate: config?.userDnTemplate ?? null,
    userSearchBase: config?.userSearchBase ?? null,
    userSearchFilter: config?.userSearchFilter ?? null,
    groupSearchBase: config?.groupSearchBase ?? null,
    groupSearchFilter: config?.groupSearchFilter ?? null,
    memberAttribute: config?.memberAttribute ?? null,
    bindDn: config?.bindDn ?? null,
    bindPasswordConfigured: Boolean(config?.bindDn && config.bindPassword),
    upnSuffix: config?.upnSuffix ?? null,
    netbiosDomain: config?.netbiosDomain ?? null,
    attributeMap: config?.attributeMap ?? DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
    timeoutMs: config?.timeoutMs ?? LDAP_DEFAULT_TIMEOUT_MS,
    ...(config?.groupRefreshMode
      ? { groupRefreshMode: config.groupRefreshMode }
      : {}),
  };
}
