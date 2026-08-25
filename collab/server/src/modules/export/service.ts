import {
  EXPORT_ENVELOPE_SCHEMA_ID,
  EXPORT_INVENTORY_SCHEMA_ID,
  type ArtifactV1,
  type ExportEnvelopeV1,
  type ExportInventoryV1,
  type PrivacyClass,
  type SourceV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { CatalogService } from "../catalog/index.js";
import type { Actor, CaseService } from "../cases/index.js";
import type { ImportService } from "../import/index.js";
import { canonicalJson } from "./canonical.js";
import type { ExportPrivacyConfig } from "./config.js";
import { briefMarkdown, packageMarkdown } from "./markdown.js";
import { PACKAGE_EXCLUDED_CONTRIBUTION_KINDS, projectBrief, projectPackage } from "./project.js";
import { containsRedactionMap } from "./redact.js";
import { PrivacyScanError, assertShareSafeClean } from "./scan.js";

export { PrivacyScanError };

export interface ExportSelection {
  kind: "artifact" | "contribution";
  id: string;
}

export class ExportService {
  constructor(
    private readonly deps: {
      cases: CaseService;
      catalog: CatalogService;
      imports: ImportService;
      audit: AuditStore;
      privacy: ExportPrivacyConfig;
    },
  ) {}

  async inventory(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<ExportInventoryV1 | null> {
    const found = await this.deps.cases.getCase(caseId, actor, isAdmin);
    if (!found) return null;
    const [contributions, artifacts] = await Promise.all([
      this.deps.cases.listContributions(caseId, actor, isAdmin),
      this.deps.cases.listArtifacts(caseId, actor, isAdmin),
    ]);
    const items = [
      ...artifacts.map((a) => ({
        kind: "artifact" as const,
        id: a.id,
        label: a.filename ?? a.kind,
        privacyClass: a.privacyClass,
        contentHash: a.contentHash,
        excludedByDefault: false,
      })),
      ...contributions.map((c) => ({
        kind: "contribution" as const,
        id: c.id,
        label: c.kind,
        privacyClass: c.privacyClass,
        contentHash: c.contentHash,
        excludedByDefault: PACKAGE_EXCLUDED_CONTRIBUTION_KINDS.has(c.kind),
      })),
    ].sort((a, b) => {
      const kind = a.kind.localeCompare(b.kind);
      return kind !== 0 ? kind : a.id.localeCompare(b.id);
    });
    return {
      schemaId: EXPORT_INVENTORY_SCHEMA_ID,
      caseId,
      items,
    };
  }

  async exportBrief(
    caseId: string,
    actor: Actor,
    variant: PrivacyClass,
    origin: string,
    isAdmin: boolean,
    canReadPrivate: boolean,
  ): Promise<ExportEnvelopeV1> {
    const snapshot = await this.loadSnapshot(caseId, actor, isAdmin, canReadPrivate);
    const payload = projectBrief({
      variant,
      caseRow: snapshot.caseRow,
      timeline: snapshot.timeline,
      contributions: snapshot.contributions,
      artifacts: snapshot.artifacts,
      runs: snapshot.runs,
      sources: snapshot.sources,
      artifactContent: snapshot.artifactContent,
      privacy: this.deps.privacy,
      ...(snapshot.memory === undefined ? {} : { memory: snapshot.memory }),
    });
    const markdown = briefMarkdown(payload);
    this.gateShareSafe(variant, payload, markdown);
    await this.deps.audit.append({
      identity: actor.id,
      action: "export_brief",
      target: `${caseId}:${variant}`,
      origin,
      outcome: "success",
    });
    return this.envelope("brief", variant, payload, markdown);
  }

  async exportPackage(
    caseId: string,
    actor: Actor,
    variant: PrivacyClass,
    selection: ExportSelection[],
    promptScaffold: string | null,
    origin: string,
    isAdmin: boolean,
    canReadPrivate: boolean,
  ): Promise<ExportEnvelopeV1> {
    const snapshot = await this.loadSnapshot(caseId, actor, isAdmin, canReadPrivate);
    const payload = projectPackage({
      variant,
      caseId,
      selection,
      contributions: snapshot.contributions,
      artifacts: snapshot.artifacts,
      sources: snapshot.sources,
      artifactContent: snapshot.artifactContent,
      promptScaffold,
      privacy: this.deps.privacy,
    });
    const markdown = packageMarkdown(payload);
    this.gateShareSafe(variant, payload, markdown);
    await this.deps.audit.append({
      identity: actor.id,
      action: "export_package",
      target: `${caseId}:${variant}:${payload.snapshotIdentity}`,
      origin,
      outcome: "success",
    });
    return this.envelope("package", variant, payload, markdown);
  }

  private gateShareSafe(variant: PrivacyClass, payload: unknown, markdown: string): void {
    if (variant !== "share_safe") return;
    if (containsRedactionMap(canonicalJson(payload), this.deps.privacy) || containsRedactionMap(markdown, this.deps.privacy)) {
      throw new PrivacyScanError([
        {
          rule: "raw_private_evidence",
          path: "$",
          excerpt: "redaction map leaked into share_safe output",
        },
      ]);
    }
    assertShareSafeClean(payload, markdown, this.deps.privacy.internalHostnameSuffixes);
  }

  private envelope(
    kind: "brief" | "package",
    variant: PrivacyClass,
    payload: ExportEnvelopeV1["payload"],
    markdown: string,
  ): ExportEnvelopeV1 {
    return {
      schemaId: EXPORT_ENVELOPE_SCHEMA_ID,
      kind,
      privacyClass: variant,
      exportedAt: new Date().toISOString(),
      payload,
      markdown,
    };
  }

  private async loadSnapshot(caseId: string, actor: Actor, isAdmin: boolean, canReadPrivate: boolean) {
    const caseRow = await this.deps.cases.getCase(caseId, actor, isAdmin);
    if (!caseRow) throw new Error("case not found");
    const [timeline, contributions, artifacts, runs, sourceList, snapshots] = await Promise.all([
      this.deps.cases.listTimeline(caseId),
      this.deps.cases.listContributions(caseId, actor, isAdmin),
      this.deps.cases.listArtifacts(caseId, actor, isAdmin),
      this.deps.imports.listRuns(caseId, actor, isAdmin),
      this.deps.catalog.list(),
      this.deps.cases.listSnapshots(caseId, actor, isAdmin),
    ]);
    const sources = new Map<string, SourceV1>(sourceList.map((s) => [s.id, s]));
    const artifactContent = await this.loadArtifactContent(caseId, actor, isAdmin, canReadPrivate, artifacts);
    const latest = snapshots.at(-1) ?? null;
    const latestIndex = latest ? snapshots.length - 1 : -1;
    const board = await this.deps.cases.getCaseBoard(caseId, actor, isAdmin);
    const boardCounts = {
      known: 0,
      unknown: 0,
      agreed: 0,
      disputed: 0,
      newlyConcluded: 0,
    };
    for (const finding of board?.findings ?? []) {
      if (finding.bucket === "newly_concluded") boardCounts.newlyConcluded += 1;
      else boardCounts[finding.bucket] += 1;
    }
    const memory =
      latest === null
        ? undefined
        : {
            latestSnapshotLabel: `S${latestIndex}`,
            latestSnapshotFingerprint: latest.fingerprint,
            parentSnapshotLabel: latest.parentSnapshotId ? `S${latestIndex - 1}` : null,
            evidenceCount: latest.evidence.length,
            lineageDepth: snapshots.length,
            boardCounts,
            agreementNotice: "Agreement is not proof of correctness." as const,
          };
    return { caseRow, timeline, contributions, artifacts, runs, sources, artifactContent, memory };
  }

  private async loadArtifactContent(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    canReadPrivate: boolean,
    artifacts: ArtifactV1[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const artifact of artifacts) {
      if (!artifact.contentHash) {
        out.set(artifact.id, null);
        continue;
      }
      const bytes = await this.deps.cases.getArtifactBytes(
        caseId,
        artifact.id,
        actor,
        isAdmin,
        canReadPrivate,
      );
      out.set(artifact.id, bytes ? new TextDecoder().decode(bytes) : null);
    }
    return out;
  }
}

export function isPrivacyClass(value: string): value is PrivacyClass {
  return value === "owner_only" || value === "share_safe";
}
