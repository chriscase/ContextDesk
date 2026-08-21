import type { RustBridgeTriageExecutorOptions } from "./runner.js";

/**
 * Resolve the host bridge without exposing credentials or provider settings to
 * Collab. COLLAB_BRIDGE_BIN is the operator-facing name; the older variable
 * remains supported for existing deployments.
 */
export function triageBridgeOptions(
  env: NodeJS.ProcessEnv = process.env,
): RustBridgeTriageExecutorOptions | null {
  const command = (env.COLLAB_BRIDGE_BIN ?? env.COLLAB_TRIAGE_RUNNER)?.trim();
  if (!command) return null;
  const options: RustBridgeTriageExecutorOptions = {
    command,
    timeoutMs: Number.parseInt(
      env.COLLAB_BRIDGE_TIMEOUT_MS ?? env.COLLAB_TRIAGE_RUNNER_TIMEOUT_MS ?? "300000",
      10,
    ),
  };
  const library = (env.COLLAB_BRIDGE_LIBRARY ?? env.COLLAB_TRIAGE_LIBRARY)?.trim();
  if (library) options.library = library;
  const dataDir = (env.COLLAB_BRIDGE_DATA_DIR ?? env.COLLAB_TRIAGE_RUNNER_DATA_DIR)?.trim();
  if (dataDir) options.dataDir = dataDir;
  return options;
}
