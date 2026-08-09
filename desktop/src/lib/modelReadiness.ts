import type {
  ModelOptionDto,
  ModelReadiness,
  ModelReadinessRole,
} from "@contextdesk/contracts";

/** Apply one qualification result to model rows already loaded in the UI. */
export type ModelReadinessUpdate = (
  profileId: string,
  modelId: string,
  readiness: ModelReadiness | null,
) => void;

const FALLBACK: ModelReadiness = {
  role: "unknown",
  state: "unverified",
  basis: "name_hint",
  tested_at: null,
  detail: "Role and ContextDesk compatibility have not been verified.",
};

/** Readiness from the trusted host, with a safe fallback for an older host. */
export function readinessFor(model: ModelOptionDto): ModelReadiness {
  return model.readiness ?? FALLBACK;
}

function roleLabel(role: ModelReadinessRole): string {
  switch (role) {
    case "chat":
      return "triage";
    case "embedding":
      return "embeddings";
    case "reranker":
      return "reranking";
    default:
      return "this role";
  }
}

/** Short picker suffix that never promotes a name hint into verification. */
export function modelReadinessLabel(model: ModelOptionDto): string {
  const readiness = readinessFor(model);
  const role = roleLabel(readiness.role);
  switch (readiness.state) {
    case "verified":
      return `verified for ${role}`;
    case "limited":
      return `limited for ${role}`;
    case "failed":
      return `${role} verification failed`;
    case "stale":
      return `${role} verification stale`;
    default:
      return readiness.role === "unknown"
        ? "not verified"
        : `not verified for ${role}`;
  }
}

/** True only for a current measured chat verification. */
export function isVerifiedChatModel(model: ModelOptionDto): boolean {
  const readiness = readinessFor(model);
  return (
    readiness.role === "chat" &&
    readiness.state === "verified" &&
    readiness.basis === "measured"
  );
}
