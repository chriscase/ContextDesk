import type { RustBridgeTriageExecutorOptions } from "./runner.js";

/**
 * Resolve the host bridge without exposing credentials or provider settings to
 * Collab. COLLAB_BRIDGE_BIN is the operator-facing name; the older variable
 * remains supported for existing deployments.
 */
export function triageBridgeOptions(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RustBridgeTriageExecutorOptions | null {
  const configuredCommand = (env.COLLAB_BRIDGE_BIN ?? env.COLLAB_TRIAGE_RUNNER)?.trim();
  if (!configuredCommand) return null;
  const rawTimeout = env.COLLAB_BRIDGE_TIMEOUT_MS ?? env.COLLAB_TRIAGE_RUNNER_TIMEOUT_MS ?? "300000";
  const timeoutMs = Number(rawTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error("COLLAB_BRIDGE_TIMEOUT_MS must be an integer between 1000 and 900000");
  }
  const options: RustBridgeTriageExecutorOptions = {
    command: configuredCommand,
    timeoutMs,
  };
  // Windows cannot execute an ES module directly (spawn reports EFTYPE).
  // Launch configured .mjs bridges through this trusted Node runtime instead;
  // the executor snapshots this prefix again before any process is spawned.
  if (platform === "win32" && configuredCommand.toLowerCase().endsWith(".mjs")) {
    options.command = process.execPath;
    options.prefixArgs = Object.freeze([configuredCommand]);
  }
  const library = (env.COLLAB_BRIDGE_LIBRARY ?? env.COLLAB_TRIAGE_LIBRARY)?.trim();
  if (library) options.library = library;
  const dataDir = (env.COLLAB_BRIDGE_DATA_DIR ?? env.COLLAB_TRIAGE_RUNNER_DATA_DIR)?.trim();
  if (dataDir) options.dataDir = dataDir;
  return options;
}
