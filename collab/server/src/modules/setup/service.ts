import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
  parsePersistedSetupState,
  projectSetupStatus,
  type SetupDeploymentDraftRequestV1,
  type SetupDeploymentSummaryV1,
  type SetupSecretPurpose,
  type SetupSecretReferenceV1,
  type SetupStatusV1,
} from "@cd-collab/contracts/setup";
import type { LdapProbeReportV1 } from "@cd-collab/contracts";
import {
  ldapConfigFromSetup,
  probeLdap,
  type LdapSessionFactory,
} from "../auth/index.js";
import {
  SetupClaimError,
  claimSetupOwner,
  transitionSetupState,
} from "./claim.js";
import {
  prepareSetupDeploymentDraft,
  SetupDeploymentConfigError,
  type PreparedSetupDeploymentDraftV1,
} from "./deployment-config.js";
import type { SetupReferencePolicy } from "./secret-ref.js";
import {
  SetupStateStoreError,
  type SetupStateStore,
} from "./state-store.js";

export const MAX_SETUP_SECRET_BYTES = 16 * 1024;
export const MAX_SETUP_LABEL_BYTES = 128;

export type SetupHttpErrorCode =
  | "setup_unavailable"
  | "invalid_request"
  | "invalid_owner_token"
  | "claim_unavailable"
  | "stale_revision"
  | "draft_unavailable"
  | "secret_reference_unavailable"
  | "configuration_invalid"
  | "setup_busy"
  | "setup_storage_unavailable";

export class SetupHttpError extends Error {
  constructor(
    readonly code: SetupHttpErrorCode,
    readonly statusCode: number,
  ) {
    super(code);
    this.name = "SetupHttpError";
  }
}

export interface SetupSecretHandleStore {
  issue(purpose: SetupSecretPurpose, value: string): SetupSecretReferenceV1;
  has(reference: SetupSecretReferenceV1): boolean;
  resolve(reference: SetupSecretReferenceV1): string | undefined;
}

interface StoredSecret {
  purpose: SetupSecretPurpose;
  value: string;
}

/**
 * Process-local host boundary. Values are accepted once and never returned.
 * Persistence and restart-safe resolution deliberately remain unavailable.
 */
export class MemorySetupSecretHandleStore implements SetupSecretHandleStore {
  private readonly values = new Map<string, StoredSecret>();

  issue(purpose: SetupSecretPurpose, value: string): SetupSecretReferenceV1 {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_SETUP_SECRET_BYTES
    ) {
      throw new SetupHttpError("invalid_request", 400);
    }
    const digest = createHash("sha256")
      .update(randomBytes(32))
      .update(purpose, "utf8")
      .digest("hex");
    const handle = `setup_secret:${purpose}:${digest}`;
    this.values.set(handle, { purpose, value });
    return { kind: "handle", purpose, fileRef: null, handle };
  }

  has(reference: SetupSecretReferenceV1): boolean {
    if (reference.kind !== "handle" || reference.handle === null) return false;
    const stored = this.values.get(reference.handle);
    return stored?.purpose === reference.purpose;
  }

  resolve(reference: SetupSecretReferenceV1): string | undefined {
    if (reference.kind !== "handle" || reference.handle === null) return undefined;
    const stored = this.values.get(reference.handle);
    if (!stored || stored.purpose !== reference.purpose) return undefined;
    return stored.value;
  }
}

export interface SetupStageInput {
  expectedRevision: number;
  deploymentLabel: string;
  draft: SetupDeploymentDraftRequestV1;
}

export interface SetupPublicDraftV1 {
  schemaId: "cd-collab.setup_public_draft.v1";
  deploymentLabel: string;
  status: SetupStatusV1;
  summary: SetupDeploymentSummaryV1;
  configurationPrepared: true;
  installationComplete: false;
}

export interface SetupVerificationCheckV1 {
  id:
    | "deployment_shape"
    | "secret_handles"
    | "storage_connectivity"
    | "authentication_connectivity"
    | "gateway_connectivity";
  status: "passed" | "not_run";
  failureCode: null | "external_connectivity_not_run" | "not_configured";
}

export interface SetupVerificationReportV1 {
  schemaId: "cd-collab.setup_verification_report.v1";
  stateRevision: number;
  draftRevision: number;
  deploymentLabel: string;
  outcome: "bounded_checks_passed";
  checks: SetupVerificationCheckV1[];
  configurationPrepared: true;
  boundedConfigurationVerified: true;
  externalConnectivityVerified: false;
  installationComplete: false;
  commitAvailable: false;
  restartAvailable: false;
  unavailableReason: "atomic_commit_and_restart_unavailable";
}

interface StagedDraft {
  stateRevision: number;
  deploymentLabel: string;
  prepared: PreparedSetupDeploymentDraftV1;
}

export interface SetupServiceOptions {
  store: SetupStateStore;
  referencePolicy: SetupReferencePolicy;
  secrets?: SetupSecretHandleStore;
  ldapSessions?: LdapSessionFactory;
}

function currentRevision(state: ReturnType<typeof parsePersistedSetupState>): number {
  return state.history.at(-1)?.revision ?? -1;
}

function configured(state: ReturnType<typeof parsePersistedSetupState>): boolean {
  return state.history.at(-1)?.phase === "configured";
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function assertOwnerToken(
  state: ReturnType<typeof parsePersistedSetupState>,
  ownerToken: string,
): void {
  const actual = typeof ownerToken === "string" && ownerToken.length <= 512
    ? Buffer.from(tokenDigest(ownerToken), "hex")
    : Buffer.alloc(0);
  const expected = Buffer.from(state.ownerTokenDigest, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new SetupHttpError("invalid_owner_token", 403);
  }
}

function assertLabel(value: unknown): asserts value is string {
  const hasControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SETUP_LABEL_BYTES ||
    hasControlCharacter
  ) {
    throw new SetupHttpError("invalid_request", 400);
  }
}

function secretReferences(draft: SetupDeploymentDraftRequestV1): SetupSecretReferenceV1[] {
  const references: SetupSecretReferenceV1[] = [];
  if (draft.storage.kind === "postgres") {
    references.push(draft.storage.databaseUrlRef, draft.storage.migrateDatabaseUrlRef);
  }
  if (draft.authentication.kind === "local" && draft.authentication.local) {
    references.push(draft.authentication.local.initialAdminPasswordRef);
  }
  if (draft.authentication.kind === "ldap" && draft.authentication.ldap?.bindPasswordRef) {
    references.push(draft.authentication.ldap.bindPasswordRef);
  }
  if (draft.gateway) references.push(draft.gateway.apiKeyRef);
  return references;
}

export class SetupService {
  private readonly store: SetupStateStore;
  private readonly referencePolicy: SetupReferencePolicy;
  private readonly secrets: SetupSecretHandleStore;
  private readonly ldapSessions: LdapSessionFactory | undefined;
  private staged: StagedDraft | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SetupServiceOptions) {
    this.store = options.store;
    this.referencePolicy = options.referencePolicy;
    this.secrets = options.secrets ?? new MemorySetupSecretHandleStore();
    this.ldapSessions = options.ldapSessions;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: () => void = () => undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async loadState(): Promise<ReturnType<typeof parsePersistedSetupState>> {
    try {
      return parsePersistedSetupState(await this.store.load());
    } catch (error) {
      throw mapSetupError(error);
    }
  }

  async status(): Promise<SetupStatusV1> {
    const state = await this.loadState();
    if (configured(state)) throw new SetupHttpError("setup_unavailable", 404);
    return projectSetupStatus(state);
  }

  async claim(raw: unknown): Promise<SetupStatusV1> {
    return this.serialized(async () => {
      const state = await this.loadState();
      if (configured(state)) throw new SetupHttpError("setup_unavailable", 404);
      try {
        return await claimSetupOwner(this.store, raw);
      } catch (error) {
        throw mapSetupError(error);
      }
    });
  }

  async issueSecret(
    ownerToken: string,
    purpose: SetupSecretPurpose,
    value: string,
  ): Promise<{ purpose: SetupSecretPurpose; handle: string }> {
    return this.serialized(async () => {
      const state = await this.loadState();
      if (configured(state)) throw new SetupHttpError("setup_unavailable", 404);
      assertOwnerToken(state, ownerToken);
      const phase = state.history.at(-1)?.phase;
      if (phase !== "claimed" && phase !== "draft" && phase !== "failed") {
        throw new SetupHttpError("claim_unavailable", 409);
      }
      const reference = this.secrets.issue(purpose, value);
      return { purpose, handle: reference.handle as string };
    });
  }

  async stage(ownerToken: string, input: SetupStageInput): Promise<SetupPublicDraftV1> {
    return this.serialized(async () => {
      const state = await this.loadState();
      if (configured(state)) throw new SetupHttpError("setup_unavailable", 404);
      assertOwnerToken(state, ownerToken);
      assertLabel(input.deploymentLabel);
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        currentRevision(state) !== input.expectedRevision ||
        input.draft.basedOnRevision !== input.expectedRevision ||
        input.draft.draftRevision !== input.expectedRevision + 1
      ) {
        throw new SetupHttpError("stale_revision", 409);
      }
      let prepared: PreparedSetupDeploymentDraftV1;
      try {
        prepared = await prepareSetupDeploymentDraft(
          state,
          input.draft,
          this.referencePolicy,
        );
      } catch (error) {
        throw mapSetupError(error);
      }
      if (secretReferences(prepared.draft).some((reference) => !this.secrets.has(reference))) {
        throw new SetupHttpError("secret_reference_unavailable", 422);
      }
      let status: SetupStatusV1;
      try {
        status = await transitionSetupState(this.store, ownerToken, {
          schemaId: "cd-collab.setup_transition_request.v1",
          expectedRevision: input.expectedRevision,
          targetPhase: "draft",
          failureCode: null,
        });
      } catch (error) {
        throw mapSetupError(error);
      }
      this.staged = {
        stateRevision: status.revision,
        deploymentLabel: input.deploymentLabel,
        prepared,
      };
      return {
        schemaId: "cd-collab.setup_public_draft.v1",
        deploymentLabel: input.deploymentLabel,
        status,
        summary: prepared.publicSummary,
        configurationPrepared: true,
        installationComplete: false,
      };
    });
  }

  async verify(ownerToken: string, expectedRevision: number): Promise<SetupVerificationReportV1> {
    return this.serialized(async () => {
      const state = await this.loadState();
      if (configured(state)) throw new SetupHttpError("setup_unavailable", 404);
      assertOwnerToken(state, ownerToken);
      if (!Number.isSafeInteger(expectedRevision) || currentRevision(state) !== expectedRevision) {
        throw new SetupHttpError("stale_revision", 409);
      }
      if (!this.staged || this.staged.stateRevision !== expectedRevision) {
        throw new SetupHttpError("draft_unavailable", 409);
      }
      const { prepared, deploymentLabel } = this.staged;
      if (secretReferences(prepared.draft).some((reference) => !this.secrets.has(reference))) {
        throw new SetupHttpError("secret_reference_unavailable", 422);
      }
      const checks: SetupVerificationCheckV1[] = [
        { id: "deployment_shape", status: "passed", failureCode: null },
        { id: "secret_handles", status: "passed", failureCode: null },
        {
          id: "storage_connectivity",
          status: "not_run",
          failureCode: "external_connectivity_not_run",
        },
        {
          id: "authentication_connectivity",
          status: "not_run",
          failureCode: "external_connectivity_not_run",
        },
        prepared.draft.gateway === null
          ? { id: "gateway_connectivity", status: "not_run", failureCode: "not_configured" }
          : {
              id: "gateway_connectivity",
              status: "not_run",
              failureCode: "external_connectivity_not_run",
            },
      ];
      return {
        schemaId: "cd-collab.setup_verification_report.v1",
        stateRevision: expectedRevision,
        draftRevision: prepared.publicSummary.draftRevision,
        deploymentLabel,
        outcome: "bounded_checks_passed",
        checks,
        configurationPrepared: true,
        boundedConfigurationVerified: true,
        externalConnectivityVerified: false,
        installationComplete: false,
        commitAvailable: false,
        restartAvailable: false,
        unavailableReason: "atomic_commit_and_restart_unavailable",
      };
    });
  }

  async probeDirectory(
    ownerToken: string,
    expectedRevision: number,
    probeUsername: string | null,
    probePassword: string | null,
  ): Promise<LdapProbeReportV1> {
    return this.serialized(async () => {
      const state = await this.loadState();
      if (configured(state)) throw new SetupHttpError("setup_unavailable", 404);
      assertOwnerToken(state, ownerToken);
      if (!Number.isSafeInteger(expectedRevision) || currentRevision(state) !== expectedRevision) {
        throw new SetupHttpError("stale_revision", 409);
      }
      if (!this.staged || this.staged.stateRevision !== expectedRevision) {
        throw new SetupHttpError("draft_unavailable", 409);
      }
      const draft = this.staged.prepared.draft;
      if (draft.authentication.kind !== "ldap" || draft.authentication.ldap === null) {
        return probeLdap({
          config: null,
          authMode: "local",
          probeUsername,
          probePassword,
          resolveRoles: () => [],
          roleMapConfigured: false,
        });
      }
      const ldap = draft.authentication.ldap;
      let bindSecret: string | undefined;
      if (ldap.bindPasswordRef) {
        bindSecret = this.secrets.resolve(ldap.bindPasswordRef);
        if (!bindSecret) throw new SetupHttpError("secret_reference_unavailable", 422);
      }
      const config = ldapConfigFromSetup(ldap, bindSecret);
      const report = await probeLdap({
        config,
        authMode: "ldap",
        probeUsername,
        probePassword,
        resolveRoles: (groups) =>
          groups.some((group) => group.toLowerCase() === ldap.adminGroup.toLowerCase())
            ? ["admin"]
            : [],
        roleMapConfigured: Boolean(ldap.adminGroup),
        ...(this.ldapSessions ? { sessions: this.ldapSessions } : {}),
      });
      return report;
    });
  }
}

function mapSetupError(error: unknown): SetupHttpError {
  if (error instanceof SetupHttpError) return error;
  if (error instanceof SetupClaimError) {
    if (error.code === "invalid_owner_token") return new SetupHttpError("invalid_owner_token", 403);
    if (error.code === "claim_unavailable") return new SetupHttpError("claim_unavailable", 409);
    if (error.code === "setup_complete") return new SetupHttpError("setup_unavailable", 404);
  }
  if (error instanceof SetupStateStoreError) {
    if (error.code === "stale_revision") return new SetupHttpError("stale_revision", 409);
    if (error.code === "state_busy") return new SetupHttpError("setup_busy", 503);
    return new SetupHttpError("setup_storage_unavailable", 503);
  }
  if (error instanceof SetupDeploymentConfigError) {
    if (error.code === "stale_revision") return new SetupHttpError("stale_revision", 409);
    if (error.code === "phase_unavailable") return new SetupHttpError("draft_unavailable", 409);
    return new SetupHttpError("configuration_invalid", 422);
  }
  return new SetupHttpError("invalid_request", 400);
}

export function setupReferencePolicy(): SetupReferencePolicy {
  return {
    secretPurposes: {
      initial_admin_password: { fileRoots: [], allowHandles: true },
      database_url: { fileRoots: [], allowHandles: true },
      migrate_database_url: { fileRoots: [], allowHandles: true },
      ldap_bind_password: { fileRoots: [], allowHandles: true },
      gateway_api_key: { fileRoots: [], allowHandles: true },
    },
    trustedCertificateRoots: [],
  };
}

export function setupDraftSummaryForTests(
  basedOnRevision: number,
): SetupDeploymentSummaryV1 {
  return {
    schemaId: SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID,
    basedOnRevision,
    draftRevision: basedOnRevision + 1,
    deploymentProfile: "single_node",
    storage: "sqlite",
    authentication: "local",
    gateway: "not_configured",
    storageVerification: "not_run",
    authenticationVerification: "not_run",
    gatewayVerification: "not_configured",
    committed: false,
  };
}
