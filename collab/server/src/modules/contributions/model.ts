import { createHash } from "node:crypto";
import {
  checkValue,
  ContractViolation,
  CONTRIBUTION_KINDS,
  f,
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

export interface HypothesisLinkInput {
  readonly kind: "artifact" | "contribution";
  readonly id: string;
}

const HYPOTHESIS_LINKS_INPUT = f.arr(f.obj({
  kind: f.req(f.en("artifact", "contribution")),
  id: f.req(f.nstr),
}));

/**
 * Parse the complete untrusted link collection before the case service resolves
 * any referenced identity. Returning fresh two-field objects keeps request-only
 * properties out of the durable contribution revision.
 */
export function parseHypothesisLinks(
  raw: unknown,
  path = "$.hypothesisLinks",
): HypothesisLinkInput[] {
  checkValue(path, HYPOTHESIS_LINKS_INPUT, raw);
  if (!Array.isArray(raw)) {
    // `checkValue` above already proves this branch unreachable, but keeping the
    // runtime guard here avoids using an unchecked assertion as authority.
    throw new ContractViolation(path, "expected array");
  }
  return raw.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new ContractViolation(`${path}[${index}]`, "expected object");
    }
    const link = candidate as Record<string, unknown>;
    const kind = link.kind;
    const id = link.id;
    if (
      (kind !== "artifact" && kind !== "contribution")
      || typeof id !== "string"
      || id.length === 0
    ) {
      // `checkValue` above already establishes these invariants. Keep the
      // narrowing explicit so this parser never turns an unchecked cast into
      // an authority decision.
      throw new ContractViolation(`${path}[${index}]`, "invalid hypothesis link");
    }
    return {
      kind,
      id,
    };
  });
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
  links: readonly HypothesisLinkInput[],
): void {
  if (status === "supported" && links.length < 1) {
    throw new Error("supported hypothesis must link to at least one artifact or contribution");
  }
}
