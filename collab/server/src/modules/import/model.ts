import { createHash } from "node:crypto";
import {
  COMPLETENESS,
  CORROBORATION_STATES,
  EVIDENCE_VISIBILITY,
  type Completeness,
  type CorroborationState,
  type EvidenceVisibility,
} from "@cd-collab/contracts";

export {
  COMPLETENESS,
  CORROBORATION_STATES,
  EVIDENCE_VISIBILITY,
  type Completeness,
  type CorroborationState,
  type EvidenceVisibility,
};

export function isCompleteness(value: string): value is Completeness {
  return (COMPLETENESS as readonly string[]).includes(value);
}

export function isEvidenceVisibility(value: string): value is EvidenceVisibility {
  return (EVIDENCE_VISIBILITY as readonly string[]).includes(value);
}

export function isCorroborationState(value: string): value is CorroborationState {
  return (CORROBORATION_STATES as readonly string[]).includes(value);
}

export function hashRunBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Import always starts unverified. Nothing upgrades this automatically. */
export function initialCorroborationState(): "unverified" {
  return "unverified";
}

export function completenessOrUnknown(value: string | undefined): Completeness {
  if (value && isCompleteness(value)) return value;
  return "unknown";
}

export function visibilityOrUnknown(value: string | undefined): EvidenceVisibility {
  if (value && isEvidenceVisibility(value)) return value;
  return "unknown";
}
