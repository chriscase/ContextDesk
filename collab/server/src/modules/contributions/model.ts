import { createHash } from "node:crypto";
import {
  CONTRIBUTION_KINDS,
  type ContributionKind,
  type HypothesisStatus,
  type PrivacyClass,
} from "@cd-collab/contracts";

export { CONTRIBUTION_KINDS, type ContributionKind };

export function defaultPrivacy(value?: PrivacyClass): PrivacyClass {
  return value ?? "owner_only";
}

export function isContributionKind(value: string): value is ContributionKind {
  return (CONTRIBUTION_KINDS as readonly string[]).includes(value);
}

/** Stable content-addressed identity for a revision (later #887/#888 manifests). */
export function hashContributionContent(
  kind: ContributionKind,
  body: string,
): string {
  return createHash("sha256").update(`${kind}\n${body}`).digest("hex");
}

export function assertSupportedLinks(
  status: HypothesisStatus,
  links: readonly { kind: "artifact" | "contribution"; id: string }[],
): void {
  if (status === "supported" && links.length < 1) {
    throw new Error("supported hypothesis must link to at least one artifact or contribution");
  }
}
