import type { ExperimentRunStatus } from "@cd-collab/contracts";
import {
  LIVE_PROFILE_ALIASES,
  type LiveProfileAlias,
} from "@cd-collab/contracts";

export interface HostLaneRequest {
  candidateId: string;
  modelLabel: string;
  profileAlias: string;
  snapshotFingerprint: string;
  taskFingerprint: string;
  cancellationId: string;
  deadlineMs: number;
}

export interface HostLaneResult {
  candidateId: string;
  runStatus: ExperimentRunStatus | "cancelled";
  evidenceRefs: string[];
  note: string;
}

export interface HostConnector {
  readonly kind: "fake" | "live";
  runLane(request: HostLaneRequest, signal: AbortSignal): Promise<HostLaneResult>;
}

export interface FakeLaneScript {
  delayMs: number;
  runStatus?: HostLaneResult["runStatus"];
  evidenceRefs?: string[];
  fail?: boolean;
}

export class FakeHostConnector implements HostConnector {
  readonly kind = "fake" as const;
  private readonly active = new Set<string>();
  maxActive = 0;
  started: string[] = [];

  constructor(private readonly scripts: Record<string, FakeLaneScript> = {}) {}

  async runLane(request: HostLaneRequest, signal: AbortSignal): Promise<HostLaneResult> {
    this.started.push(request.candidateId);
    this.active.add(request.candidateId);
    this.maxActive = Math.max(this.maxActive, this.active.size);
    const script = this.scripts[request.candidateId] ?? { delayMs: 20 };
    try {
      await wait(script.delayMs, signal);
      if (script.fail) {
        return {
          candidateId: request.candidateId,
          runStatus: "failed",
          evidenceRefs: [],
          note: "synthetic_lane_failed",
        };
      }
      return {
        candidateId: request.candidateId,
        runStatus: script.runStatus ?? "completed",
        evidenceRefs: script.evidenceRefs ?? ["ev-demo-checkout-log"],
        note: "synthetic_fixture",
      };
    } catch (error) {
      if (signal.aborted) {
        return {
          candidateId: request.candidateId,
          runStatus: "cancelled",
          evidenceRefs: [],
          note: "cancelled",
        };
      }
      throw error;
    } finally {
      this.active.delete(request.candidateId);
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface LiveProfileState {
  alias: LiveProfileAlias;
  configured: boolean;
  ran: boolean;
  skippedReason: string | null;
}

/** Opt-in live matrix. Never infers credentials; never records secrets. */
export function inspectLiveProfiles(env: NodeJS.ProcessEnv = process.env): LiveProfileState[] {
  const configured = new Set(
    (env.COLLAB_LIVE_PROFILES ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  const vercel = env.COLLAB_LIVE_VERCEL === "1";
  return LIVE_PROFILE_ALIASES.map((alias) => {
    const isConfigured =
      alias === "vercel-compatible" ? vercel || configured.has(alias) : configured.has(alias);
    if (!isConfigured) {
      return {
        alias,
        configured: false,
        ran: false,
        skippedReason: "credentials_not_configured",
      };
    }
    return {
      alias,
      configured: true,
      ran: false,
      skippedReason: "opt_in_host_not_invoked_in_hermetic_suite",
    };
  });
}

/**
 * Live host connector is a documented seam only. Qualification tests never
 * construct it. A real invocation requires COLLAB_LIVE_PROFILES and must
 * redact connector stdout before any report is written.
 */
export class LiveHostConnector implements HostConnector {
  readonly kind = "live" as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async runLane(): Promise<HostLaneResult> {
    if (!this.env.COLLAB_LIVE_PROFILES && this.env.COLLAB_LIVE_VERCEL !== "1") {
      throw new Error("live host connector refused: credentials_not_configured");
    }
    throw new Error("live host connector is opt-in and is not invoked by hermetic tests");
  }
}
