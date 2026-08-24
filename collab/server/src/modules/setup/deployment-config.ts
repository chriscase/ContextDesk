import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { ContractViolation } from "@cd-collab/contracts";
import {
  SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
  parsePersistedSetupState,
  parseSetupDeploymentDraftRequest,
  parseSetupDeploymentSummary,
  type PersistedSetupStateV1,
  type SetupAuthenticationV1,
  type SetupDeploymentDraftRequestV1,
  type SetupDeploymentSummaryV1,
  type SetupGatewayV1,
  type SetupLdapAuthenticationV1,
  type SetupSecretPurpose,
  type SetupSecretReferenceV1,
  type SetupStorageV1,
} from "@cd-collab/contracts/setup";
import {
  SetupSecretReferenceError,
  validateSetupSecretReference,
  validateSetupTrustedCertificateReference,
  type SetupReferencePolicy,
} from "./secret-ref.js";

export type SetupDeploymentConfigErrorCode =
  | "invalid_config"
  | "stale_revision"
  | "phase_unavailable"
  | "path_not_absolute"
  | "path_not_normalized"
  | "path_outside_data_root"
  | "path_overlap"
  | "filesystem_reference_unsupported"
  | "invalid_gateway_url"
  | "invalid_ldap_url"
  | "invalid_ldap_configuration"
  | "secret_reference_invalid"
  | "trusted_certificate_reference_invalid";

export class SetupDeploymentConfigError extends Error {
  constructor(readonly code: SetupDeploymentConfigErrorCode) {
    super(code);
    this.name = "SetupDeploymentConfigError";
  }
}

const SECRET_REFERENCE_PATHS = [
  "$.storage.databaseUrlRef",
  "$.storage.migrateDatabaseUrlRef",
  "$.authentication.local.initialAdminPasswordRef",
  "$.authentication.ldap.bindPasswordRef",
  "$.gateway.apiKeyRef",
] as const;
const TRUSTED_CERTIFICATE_REFERENCE_PATH =
  "$.authentication.ldap.caCertificateRef";

function referenceViolationCode(
  error: unknown,
): SetupDeploymentConfigErrorCode | null {
  if (!(error instanceof ContractViolation)) return null;
  if (
    error.path === TRUSTED_CERTIFICATE_REFERENCE_PATH ||
    error.path.startsWith(`${TRUSTED_CERTIFICATE_REFERENCE_PATH}.`)
  ) {
    return "trusted_certificate_reference_invalid";
  }
  if (
    SECRET_REFERENCE_PATHS.some(
      (path) => error.path === path || error.path.startsWith(`${path}.`),
    )
  ) {
    return "secret_reference_invalid";
  }
  return null;
}

export interface PreparedSetupDeploymentDraftV1 {
  /**
   * Server-internal normalized draft. References remain untrusted syntax,
   * never capabilities and not proven secret-free. This slice accepts only
   * host-policy-enabled opaque handle syntax; filesystem references fail.
   */
  draft: SetupDeploymentDraftRequestV1;
  /** API-safe, explicitly unverified and uncommitted projection. */
  publicSummary: SetupDeploymentSummaryV1;
}

function normalizeAbsolutePath(value: string): string {
  if (!isAbsolute(value)) {
    throw new SetupDeploymentConfigError("path_not_absolute");
  }
  const normalized = resolve(value);
  if (normalized !== value || normalized === parse(normalized).root) {
    throw new SetupDeploymentConfigError("path_not_normalized");
  }
  return normalized;
}

function requireLexicalContainment(dataRoot: string, candidate: string): string {
  const normalized = normalizeAbsolutePath(candidate);
  const fromRoot = relative(dataRoot, normalized);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new SetupDeploymentConfigError("path_outside_data_root");
  }
  return normalized;
}

function isLexicallySameOrDescendant(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (fromParent !== ".." &&
      !fromParent.startsWith(`..${sep}`) &&
      !isAbsolute(fromParent))
  );
}

function assertLexicallyDisjoint(left: string, right: string): void {
  if (
    isLexicallySameOrDescendant(left, right) ||
    isLexicallySameOrDescendant(right, left)
  ) {
    throw new SetupDeploymentConfigError("path_overlap");
  }
}

function normalizeUrl(url: URL): string {
  const normalized = url.toString();
  if (url.pathname === "/" && !url.search && !url.hash) {
    return normalized.slice(0, -1);
  }
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function hasUrlSecretsOrModifiers(url: URL): boolean {
  return (
    url.username.length > 0 ||
    url.href.includes("@") ||
    url.search.length > 0 ||
    url.hash.length > 0
  );
}

function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SetupDeploymentConfigError("invalid_gateway_url");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    hasUrlSecretsOrModifiers(url) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new SetupDeploymentConfigError("invalid_gateway_url");
  }
  return normalizeUrl(url);
}

function normalizeLdapUrl(value: string, starttls: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SetupDeploymentConfigError("invalid_ldap_url");
  }
  const encrypted = url.protocol === "ldaps:" && !starttls;
  const upgraded = url.protocol === "ldap:" && starttls;
  if (
    hasUrlSecretsOrModifiers(url) ||
    url.pathname !== "" ||
    (!encrypted && !upgraded)
  ) {
    throw new SetupDeploymentConfigError("invalid_ldap_url");
  }
  return normalizeUrl(url);
}

async function validateSecret(
  reference: SetupSecretReferenceV1,
  purpose: SetupSecretPurpose,
  policy: SetupReferencePolicy,
): Promise<SetupSecretReferenceV1> {
  try {
    return await validateSetupSecretReference(reference, purpose, policy);
  } catch (error) {
    if (error instanceof SetupSecretReferenceError) {
      if (error.code === "filesystem_reference_unsupported") {
        throw new SetupDeploymentConfigError(
          "filesystem_reference_unsupported",
        );
      }
      if (error.code === "invalid_reference") {
        throw new SetupDeploymentConfigError("secret_reference_invalid");
      }
    }
    throw new SetupDeploymentConfigError("invalid_config");
  }
}

async function validateTrustedCertificate(
  reference: NonNullable<SetupLdapAuthenticationV1["caCertificateRef"]>,
  policy: SetupReferencePolicy,
) {
  try {
    return await validateSetupTrustedCertificateReference(reference, policy);
  } catch (error) {
    if (error instanceof SetupSecretReferenceError) {
      if (error.code === "filesystem_reference_unsupported") {
        throw new SetupDeploymentConfigError(
          "filesystem_reference_unsupported",
        );
      }
      if (error.code === "invalid_reference") {
        throw new SetupDeploymentConfigError(
          "trusted_certificate_reference_invalid",
        );
      }
    }
    throw new SetupDeploymentConfigError("invalid_config");
  }
}

async function normalizeStorage(
  storage: SetupStorageV1,
  policy: SetupReferencePolicy,
  dataRoot: string,
): Promise<SetupStorageV1> {
  if (storage.kind === "sqlite") {
    return {
      ...storage,
      // This is separator-aware lexical containment only. Slice C must prove
      // the created path's filesystem identity before opening or mutating it.
      sqlitePath: requireLexicalContainment(dataRoot, storage.sqlitePath),
    };
  }
  return {
    ...storage,
    databaseUrlRef: await validateSecret(
      storage.databaseUrlRef,
      "database_url",
      policy,
    ),
    migrateDatabaseUrlRef: await validateSecret(
      storage.migrateDatabaseUrlRef,
      "migrate_database_url",
      policy,
    ),
  };
}

function assertLdapSemantics(ldap: SetupLdapAuthenticationV1): void {
  const hasTemplate = ldap.userDnTemplate !== null;
  const hasSearch = ldap.userSearchBase !== null;
  if (hasTemplate === hasSearch) {
    throw new SetupDeploymentConfigError("invalid_ldap_configuration");
  }
  if (
    (ldap.bindDn === null) !== (ldap.bindPasswordRef === null) ||
    (hasTemplate && !ldap.userDnTemplate?.includes("{username}")) ||
    (hasSearch && !ldap.userSearchFilter.includes("{username}")) ||
    !ldap.groupSearchFilter.includes("{dn}")
  ) {
    throw new SetupDeploymentConfigError("invalid_ldap_configuration");
  }
}

async function normalizeAuthentication(
  authentication: SetupAuthenticationV1,
  policy: SetupReferencePolicy,
): Promise<SetupAuthenticationV1> {
  if (authentication.kind === "local") {
    const local = authentication.local;
    if (local === null) {
      throw new SetupDeploymentConfigError("invalid_config");
    }
    return {
      kind: "local",
      local: {
        ...local,
        initialAdminPasswordRef: await validateSecret(
          local.initialAdminPasswordRef,
          "initial_admin_password",
          policy,
        ),
      },
      ldap: null,
    };
  }

  const ldap = authentication.ldap;
  if (ldap === null) {
    throw new SetupDeploymentConfigError("invalid_config");
  }
  assertLdapSemantics(ldap);
  // Slice C must preserve the production adapter's RFC 4514 DN escaping and
  // RFC 4515 filter escaping when these strict templates are interpolated.
  return {
    kind: "ldap",
    local: null,
    ldap: {
      ...ldap,
      url: normalizeLdapUrl(ldap.url, ldap.starttls),
      caCertificateRef:
        ldap.caCertificateRef === null
          ? null
          : await validateTrustedCertificate(ldap.caCertificateRef, policy),
      bindPasswordRef:
        ldap.bindPasswordRef === null
          ? null
          : await validateSecret(
              ldap.bindPasswordRef,
              "ldap_bind_password",
              policy,
            ),
    },
  };
}

async function normalizeGateway(
  gateway: SetupGatewayV1 | null,
  policy: SetupReferencePolicy,
): Promise<SetupGatewayV1 | null> {
  if (gateway === null) return null;
  return {
    ...gateway,
    baseUrl: normalizeGatewayUrl(gateway.baseUrl),
    apiKeyRef: await validateSecret(gateway.apiKeyRef, "gateway_api_key", policy),
  };
}

function currentState(state: PersistedSetupStateV1) {
  const current = state.history.at(-1);
  if (!current) throw new SetupDeploymentConfigError("invalid_config");
  return current;
}

function hasFilesystemReference(
  request: SetupDeploymentDraftRequestV1,
): boolean {
  const secretReferences: SetupSecretReferenceV1[] = [];
  if (request.storage.kind === "postgres") {
    secretReferences.push(
      request.storage.databaseUrlRef,
      request.storage.migrateDatabaseUrlRef,
    );
  }
  if (request.authentication.kind === "local") {
    const local = request.authentication.local;
    if (local !== null) secretReferences.push(local.initialAdminPasswordRef);
  } else {
    const ldap = request.authentication.ldap;
    if (ldap !== null) {
      if (ldap.caCertificateRef !== null) return true;
      if (ldap.bindPasswordRef !== null) {
        secretReferences.push(ldap.bindPasswordRef);
      }
    }
  }
  if (request.gateway !== null) {
    secretReferences.push(request.gateway.apiKeyRef);
  }
  return secretReferences.some((reference) => reference.kind === "file");
}

/**
 * Validate and normalize a setup draft. This function does not persist,
 * verify, contact, or commit any component.
 */
export async function prepareSetupDeploymentDraft(
  rawState: unknown,
  rawRequest: unknown,
  referencePolicy: SetupReferencePolicy,
): Promise<PreparedSetupDeploymentDraftV1> {
  let state: PersistedSetupStateV1;
  let request: SetupDeploymentDraftRequestV1;
  try {
    state = parsePersistedSetupState(rawState);
  } catch {
    throw new SetupDeploymentConfigError("invalid_config");
  }
  try {
    request = parseSetupDeploymentDraftRequest(rawRequest);
  } catch (error) {
    throw new SetupDeploymentConfigError(
      referenceViolationCode(error) ?? "invalid_config",
    );
  }
  const current = currentState(state);
  if (current.revision !== request.basedOnRevision) {
    throw new SetupDeploymentConfigError("stale_revision");
  }
  if (
    current.phase !== "claimed" &&
    current.phase !== "draft" &&
    current.phase !== "failed"
  ) {
    throw new SetupDeploymentConfigError("phase_unavailable");
  }
  if (hasFilesystemReference(request)) {
    throw new SetupDeploymentConfigError("filesystem_reference_unsupported");
  }

  const dataRoot = normalizeAbsolutePath(request.dataRoot);
  const evidenceRoot = requireLexicalContainment(
    dataRoot,
    request.evidenceRoot,
  );
  const storage = await normalizeStorage(
    request.storage,
    referencePolicy,
    dataRoot,
  );
  if (storage.kind === "sqlite") {
    assertLexicallyDisjoint(storage.sqlitePath, evidenceRoot);
  }
  const draft: SetupDeploymentDraftRequestV1 = {
    ...request,
    dataRoot,
    // Like sqlitePath, this is a lexical boundary only; no directory is
    // created or trusted by this preparation seam.
    evidenceRoot,
    storage,
    authentication: await normalizeAuthentication(
      request.authentication,
      referencePolicy,
    ),
    gateway: await normalizeGateway(request.gateway, referencePolicy),
  };
  const publicSummary = parseSetupDeploymentSummary({
    schemaId: SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
    basedOnRevision: request.basedOnRevision,
    draftRevision: request.draftRevision,
    deploymentProfile: request.deploymentProfile,
    storage: request.storage.kind,
    authentication: request.authentication.kind,
    gateway: request.gateway === null ? "not_configured" : "openai_compatible",
    storageVerification: "not_run",
    authenticationVerification: "not_run",
    gatewayVerification: request.gateway === null ? "not_configured" : "not_run",
    committed: false,
  });
  return { draft, publicSummary };
}
