import type { LogTimeBridgeOptions } from "./bridge.js";

/**
 * Resolve the host pipeline this deployment should use for log-time review.
 *
 * Returns `null` when no host binary is configured. The caller then leaves the
 * review routes unregistered rather than serving a surface that cannot answer:
 * every timestamp decision belongs to the shipped pipeline, so with no pipeline
 * there is nothing honest to show.
 *
 * `COLLAB_BRIDGE_BIN` is shared with the triage bridge — it is the same
 * `contextdesk` binary — but the corpus cache root is separate and required, so
 * a deployment must say where durable case corpora live before any is built.
 */
export function logTimeBridgeOptions(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LogTimeBridgeOptions | null {
  const configuredCommand = (env.COLLAB_BRIDGE_BIN ?? env.COLLAB_TRIAGE_RUNNER)?.trim();
  const cacheRoot = env.COLLAB_LOG_CORPUS_ROOT?.trim();
  if (!configuredCommand || !cacheRoot) return null;

  const rawTimeout = env.COLLAB_LOG_TIME_TIMEOUT_MS ?? "120000";
  const timeoutMs = Number(rawTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error("COLLAB_LOG_TIME_TIMEOUT_MS must be an integer between 1000 and 900000");
  }

  const options: LogTimeBridgeOptions = {
    command: configuredCommand,
    cacheRoot,
    timeoutMs,
  };
  // Windows cannot execute an ES module directly (spawn reports EFTYPE).
  // Launch a configured .mjs shim through this trusted Node runtime instead.
  if (platform === "win32" && configuredCommand.toLowerCase().endsWith(".mjs")) {
    options.command = process.execPath;
    options.prefixArgs = [configuredCommand];
  }
  return options;
}
