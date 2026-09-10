import {
  createEvidenceRuntime,
  type CreateEvidenceStoreOptions,
  type EvidenceRuntime,
} from "../../evidence/provider.js";
import {
  isEvidenceProviderInstanceStorageError,
  type EvidenceProviderInstanceStorageErrorCode,
} from "../../evidence/provider-instance.js";
import {
  loadEvidenceS3Credentials,
  type EvidenceS3Credentials,
} from "../../evidence/s3-secrets.js";
import {
  loadEvidenceStorageSettings,
  type LoadedEvidenceStorageSettings,
} from "../../evidence/s3-settings.js";

export const PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID =
  "cd-collab.evidence_provider_identity_operator.v1" as const;

export type ProviderIdentityAction = "inspect" | "init";
export type ProviderIdentityStatus =
  | "legacy_unbound"
  | "uninitialized"
  | "matching"
  | "created"
  | "existing"
  | "reconciled";

export type ProviderIdentityOperatorErrorCode =
  | "invalid_arguments"
  | "confirmation_required"
  | "pin_required"
  | "invalid_configuration"
  | EvidenceProviderInstanceStorageErrorCode;

export interface ProviderIdentityCliArgs {
  readonly action: ProviderIdentityAction;
  readonly envFile: string;
  readonly confirmed: boolean;
}

export interface ProviderIdentityResult {
  readonly schemaId: typeof PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID;
  readonly action: ProviderIdentityAction;
  readonly status: ProviderIdentityStatus;
  readonly provider: "filesystem" | "s3";
}

export class ProviderIdentityOperatorError extends Error {
  readonly code: ProviderIdentityOperatorErrorCode;

  constructor(code: ProviderIdentityOperatorErrorCode) {
    super("evidence provider identity operation failed");
    this.name = "ProviderIdentityOperatorError";
    this.code = code;
  }
}

export interface ProviderIdentityOperatorDeps {
  loadSettings(
    env: NodeJS.ProcessEnv,
    context: { controlRoot: string; storage: "postgres" | "sqlite" },
  ): LoadedEvidenceStorageSettings;
  loadCredentials(env: NodeJS.ProcessEnv): EvidenceS3Credentials;
  createRuntime(options: CreateEvidenceStoreOptions): EvidenceRuntime;
}

const DEFAULT_DEPS: ProviderIdentityOperatorDeps = {
  loadSettings: loadEvidenceStorageSettings,
  loadCredentials: loadEvidenceS3Credentials,
  createRuntime: createEvidenceRuntime,
};

export function parseProviderIdentityCliArgs(argv: readonly string[]): ProviderIdentityCliArgs {
  try {
    if (argv.length < 1 || (argv[0] !== "inspect" && argv[0] !== "init")) {
      throw new ProviderIdentityOperatorError("invalid_arguments");
    }
    const action = argv[0];
    let envFile: string | undefined;
    let confirmed = false;
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--env-file" && envFile === undefined) {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) fail("invalid_arguments");
        envFile = value;
        index += 1;
        continue;
      }
      if (arg === "--yes" && !confirmed) {
        confirmed = true;
        continue;
      }
      fail("invalid_arguments");
    }
    if (!envFile) fail("invalid_arguments");
    if (action === "inspect" && confirmed) fail("invalid_arguments");
    if (action === "init" && !confirmed) fail("confirmation_required");
    return Object.freeze({ action, envFile, confirmed });
  } catch (error) {
    if (error instanceof ProviderIdentityOperatorError) throw error;
    fail("invalid_arguments");
  }
}

export async function executeProviderIdentityOperation(input: {
  readonly action: ProviderIdentityAction;
  readonly env: NodeJS.ProcessEnv;
  readonly confirmed?: boolean;
  readonly deps?: ProviderIdentityOperatorDeps;
}): Promise<ProviderIdentityResult> {
  if (input.action !== "inspect" && input.action !== "init") {
    fail("invalid_arguments");
  }
  if (input.action === "init" && input.confirmed !== true) {
    fail("confirmation_required");
  }
  const deps = input.deps ?? DEFAULT_DEPS;
  let settings: LoadedEvidenceStorageSettings;
  try {
    const storage = parseStorage(input.env.COLLAB_STORAGE);
    const root = input.env.COLLAB_EVIDENCE_ROOT?.trim() || ".data/evidence";
    settings = deps.loadSettings(input.env, { controlRoot: root, storage });
  } catch {
    fail("invalid_configuration");
  }
  if (settings.expectedProviderInstanceId === undefined) {
    if (input.action === "init") fail("pin_required");
    return result(input.action, "legacy_unbound", settings.provider);
  }
  let runtime: EvidenceRuntime;
  try {
    runtime = deps.createRuntime({
      settings,
      ...(settings.provider === "s3"
        ? { credentials: deps.loadCredentials(input.env) }
        : {}),
    });
  } catch {
    fail("invalid_configuration");
  }
  try {
    if (input.action === "inspect") {
      const inspected = await runtime.inspectProviderInstance();
      return result("inspect", inspected === null ? "uninitialized" : "matching", settings.provider);
    }
    const initialized = await runtime.initializeProviderInstance();
    if (initialized === null) fail("pin_required");
    return result("init", initialized.outcome, settings.provider);
  } catch (error) {
    if (isEvidenceProviderInstanceStorageError(error)) fail(error.code);
    if (error instanceof ProviderIdentityOperatorError) throw error;
    fail("unavailable");
  }
}

export function providerIdentityErrorCode(error: unknown): ProviderIdentityOperatorErrorCode {
  return error instanceof ProviderIdentityOperatorError ? error.code : "unavailable";
}

function parseStorage(value: string | undefined): "postgres" | "sqlite" {
  const storage = (value ?? "postgres").trim().toLowerCase();
  if (storage !== "postgres" && storage !== "sqlite") fail("invalid_configuration");
  return storage;
}

function result(
  action: ProviderIdentityAction,
  status: ProviderIdentityStatus,
  provider: "filesystem" | "s3",
): ProviderIdentityResult {
  return Object.freeze({
    schemaId: PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID,
    action,
    status,
    provider,
  });
}

function fail(code: ProviderIdentityOperatorErrorCode): never {
  throw new ProviderIdentityOperatorError(code);
}
