import { LIVE_PROFILE_ALIASES, type QualificationLiveProfileV1 } from "@cd-collab/contracts";

/** Opt-in live matrix. Never infers credentials and never records secrets. */
export function inspectLiveProfiles(env: NodeJS.ProcessEnv = process.env): QualificationLiveProfileV1[] {
  const configured = new Set((env.COLLAB_LIVE_PROFILES ?? "").split(",").map((part) => part.trim()).filter(Boolean));
  const vercel = env.COLLAB_LIVE_VERCEL === "1";
  return LIVE_PROFILE_ALIASES.map((alias) => {
    const isConfigured = alias === "vercel-compatible" ? vercel || configured.has(alias) : configured.has(alias);
    return isConfigured
      ? { alias, configured: true, ran: false, skippedReason: "opt_in_host_not_invoked_in_hermetic_suite" }
      : { alias, configured: false, ran: false, skippedReason: "credentials_not_configured" };
  });
}
