import {
  BRIEF_SCHEMA_ID,
  IMPORTED_RESPONSE_PRESENTATION,
  PACKAGE_DEFAULT_EXCLUSIONS,
  PACKAGE_MANIFEST_SCHEMA_ID,
  PACKAGE_SCHEMA_ID,
  type ArtifactV1,
  type BriefV1,
  type ContributionV1,
  type ExternalRunV1,
  type PrivacyClass,
  type PromptPackageV1,
  type SourceV1,
} from "@cd-collab/contracts";
import type { CaseV1 } from "@cd-collab/contracts";
import type { TimelineRow } from "../cases/index.js";
import { canonicalJson, payloadDigest, sha256Text } from "./canonical.js";
import type { ExportPrivacyConfig } from "./config.js";
import { shareSafeLabel } from "./redact.js";

export const PACKAGE_EXCLUDED_CONTRIBUTION_KINDS = new Set(["external_run"]);

export function sourceLabelOf(
  sources: ReadonlyMap<string, SourceV1>,
  sourceId: string,
  privacy: ExportPrivacyConfig,
  variant: PrivacyClass,
): string {
  const name = sources.get(sourceId)?.name ?? "unknown";
  return shareSafeLabel(name, privacy, variant, "source");
}

export function artifactIdentityHash(artifact: ArtifactV1): string {
  return artifact.contentHash ?? artifact.expectedHash ?? "";
}

function includeContent(variant: PrivacyClass, privacyClass: PrivacyClass): boolean {
  return variant === "owner_only" || privacyClass === "share_safe";
}

function targetKind(eventKind: string): string {
  if (eventKind.startsWith("evidence")) return "artifact";
  if (eventKind.includes("contribution") || eventKind === "hypothesis_status") return "contribution";
  if (eventKind.startsWith("external_run") || eventKind === "run_corroboration") return "imported_run";
  if (eventKind.startsWith("case") || eventKind === "legal_hold" || eventKind === "membership") {
    return "case";
  }
  return "event";
}

export function projectBrief(input: {
  variant: PrivacyClass;
  caseRow: CaseV1;
  timeline: TimelineRow[];
  contributions: ContributionV1[];
  artifacts: ArtifactV1[];
  runs: ExternalRunV1[];
  sources: ReadonlyMap<string, SourceV1>;
  artifactContent: ReadonlyMap<string, string | null>;
  privacy: ExportPrivacyConfig;
}): BriefV1 {
  const { variant } = input;
  const label = (raw: string) => shareSafeLabel(raw, input.privacy, variant, "identity");
  const targetLabel = (raw: string) => shareSafeLabel(raw, input.privacy, variant, "target");

  const timeline = [...input.timeline]
    .sort((a, b) => a.seq - b.seq)
    .map((ev) => ({
      seq: ev.seq,
      kind: ev.kind,
      actorLabel: label(ev.actorUsername),
      targetId: ev.targetId === null ? null : targetLabel(ev.targetId),
      payloadDigest: payloadDigest(ev.payload),
    }));

  const hypotheses = input.contributions
    .filter((c) => c.kind === "hypothesis")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const links = [...(c.hypothesisLinks ?? [])].sort((a, b) => a.id.localeCompare(b.id));
      const supporting = c.hypothesisStatus === "contradicted" ? [] : links;
      const contradicting = c.hypothesisStatus === "contradicted" ? links : [];
      return {
        id: c.id,
        status: c.hypothesisStatus ?? "proposed",
        body: includeContent(variant, c.privacyClass) ? c.body : null,
        contentHash: c.contentHash,
        sourceLabel: sourceLabelOf(input.sources, c.sourceId, input.privacy, variant),
        supporting,
        contradicting,
      };
    });

  const actions = input.contributions
    .filter((c) => c.kind === "action")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      body: includeContent(variant, c.privacyClass) ? c.body : null,
      contentHash: c.contentHash,
      actorLabel: label(c.authorUsername),
      sourceLabel: sourceLabelOf(input.sources, c.sourceId, input.privacy, variant),
    }));

  const evidence = [...input.artifacts]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => {
      const allowed = includeContent(variant, a.privacyClass);
      const content = allowed ? (input.artifactContent.get(a.id) ?? null) : null;
      return {
        id: a.id,
        kind: a.kind,
        filename: a.filename,
        contentHash: a.contentHash,
        sourceLabel: sourceLabelOf(input.sources, a.sourceId, input.privacy, variant),
        privacyClass: a.privacyClass,
        verificationStatus: a.verificationStatus,
        content,
        bytesIncluded: allowed && content !== null,
      };
    });

  const attributions = timeline.map((ev) => ({
    actorLabel: ev.actorLabel,
    action: ev.kind,
    targetKind: targetKind(ev.kind),
    targetId: ev.targetId,
  }));

  const importedRuns = [...input.runs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((run) => {
      const allowed = includeContent(variant, run.privacyClass);
      return {
        id: run.id,
        sourceLabel: sourceLabelOf(input.sources, run.sourceId, input.privacy, variant),
        corroborationState: run.corroborationState,
        snapshotBinding: run.snapshotBinding,
        presentation: IMPORTED_RESPONSE_PRESENTATION,
        outputIncluded: allowed,
        outputText: allowed ? run.outputText : null,
      };
    });

  return {
    schemaId: BRIEF_SCHEMA_ID,
    privacyClass: variant,
    header: {
      caseId: input.caseRow.id,
      title: input.caseRow.title,
      severity: input.caseRow.severity,
      status: input.caseRow.status,
      legalHold: input.caseRow.legalHold,
      retentionClass: input.caseRow.retentionClass,
    },
    timeline,
    hypotheses,
    actions,
    evidence,
    attributions,
    importedRuns,
  };
}

export function projectPackage(input: {
  variant: PrivacyClass;
  caseId: string;
  selection: { kind: "artifact" | "contribution"; id: string }[];
  contributions: ContributionV1[];
  artifacts: ArtifactV1[];
  sources: ReadonlyMap<string, SourceV1>;
  artifactContent: ReadonlyMap<string, string | null>;
  promptScaffold: string | null;
  privacy: ExportPrivacyConfig;
}): PromptPackageV1 {
  const contribById = new Map(input.contributions.map((c) => [c.id, c]));
  const artifactById = new Map(input.artifacts.map((a) => [a.id, a]));
  const selected = [...input.selection].sort((a, b) => {
    const kind = a.kind.localeCompare(b.kind);
    return kind !== 0 ? kind : a.id.localeCompare(b.id);
  });

  const excerpts: PromptPackageV1["excerpts"] = [];
  for (const item of selected) {
    if (item.kind === "contribution") {
      const c = contribById.get(item.id);
      if (!c) throw new Error(`selection not found: contribution:${item.id}`);
      if (PACKAGE_EXCLUDED_CONTRIBUTION_KINDS.has(c.kind)) continue;
      const allowed = includeContent(input.variant, c.privacyClass);
      excerpts.push({
        kind: "contribution",
        id: c.id,
        contentHash: c.contentHash,
        sourceLabel: sourceLabelOf(input.sources, c.sourceId, input.privacy, input.variant),
        privacyClass: c.privacyClass,
        content: allowed ? c.body : null,
        bodyIncluded: allowed && c.body !== null,
      });
      continue;
    }
    const a = artifactById.get(item.id);
    if (!a) throw new Error(`selection not found: artifact:${item.id}`);
    const allowed = includeContent(input.variant, a.privacyClass);
    const content = allowed ? (input.artifactContent.get(a.id) ?? null) : null;
    excerpts.push({
      kind: "artifact",
      id: a.id,
      contentHash: artifactIdentityHash(a),
      sourceLabel: sourceLabelOf(input.sources, a.sourceId, input.privacy, input.variant),
      privacyClass: a.privacyClass,
      content,
      bodyIncluded: allowed && content !== null,
    });
  }

  if (excerpts.length === 0) {
    throw new Error("selection empty after default exclusions");
  }

  const promptScaffold = input.promptScaffold;
  const manifest = {
    schemaId: PACKAGE_MANIFEST_SCHEMA_ID,
    caseId: input.caseId,
    variant: input.variant,
    items: excerpts.map((ex) => ({
      kind: ex.kind,
      id: ex.id,
      contentHash: ex.contentHash,
      privacyClass: ex.privacyClass,
    })),
    promptScaffoldHash: promptScaffold === null ? null : sha256Text(promptScaffold),
    excludedByDefault: [...PACKAGE_DEFAULT_EXCLUSIONS],
  };
  const snapshotIdentity = sha256Text(canonicalJson(manifest));

  return {
    schemaId: PACKAGE_SCHEMA_ID,
    privacyClass: input.variant,
    caseId: input.caseId,
    snapshotIdentity,
    manifest,
    excerpts,
    promptScaffold,
  };
}
