/** Operator readiness, configuration, and evidence-provider identity tools. */
export const MODULE_ID = "operator" as const;

export { runDoctor } from "./doctor.js";
export type { DoctorInput } from "./doctor.js";
export { initConfig, renderConfigFile, CONFIG_INIT_PROFILES } from "./config-init.js";
export type { ConfigInitInput, ConfigInitProfile, ConfigInitResult } from "./config-init.js";
export { parseEnvFile, mergeEnv } from "./env-file.js";
export { nodeOperatorFs } from "./fs.js";
export type { OperatorFs } from "./fs.js";
export { assertReleaseArtifactSafe, sanitizeCiArtifacts } from "./ci-artifact.js";
export {
  executeProviderIdentityOperation,
  parseProviderIdentityCliArgs,
  providerIdentityErrorCode,
  PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID,
  ProviderIdentityOperatorError,
} from "./provider-identity.js";
export type {
  ProviderIdentityAction,
  ProviderIdentityCliArgs,
  ProviderIdentityOperatorDeps,
  ProviderIdentityOperatorErrorCode,
  ProviderIdentityResult,
  ProviderIdentityStatus,
} from "./provider-identity.js";
