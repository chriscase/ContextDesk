import type { BriefV1, PromptPackageV1 } from "@cd-collab/contracts";

function line(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function briefMarkdown(brief: BriefV1): string {
  const lines: string[] = [];
  lines.push(`# Triage brief`);
  lines.push("");
  lines.push(`- schema: ${brief.schemaId}`);
  lines.push(`- privacy: ${brief.privacyClass}`);
  lines.push(`- case: ${brief.header.title} (${brief.header.caseId})`);
  lines.push(`- severity: ${brief.header.severity}`);
  lines.push(`- status: ${brief.header.status}`);
  lines.push(`- legal hold: ${brief.header.legalHold ? "yes" : "no"}`);
  lines.push(`- retention: ${brief.header.retentionClass}`);
  if (brief.memory) {
    lines.push(`- latest snapshot: ${brief.memory.latestSnapshotLabel ?? "none"}`);
    lines.push(`- snapshot lineage depth: ${brief.memory.lineageDepth}`);
    lines.push(`- snapshot evidence: ${brief.memory.evidenceCount}`);
  }
  lines.push("");
  lines.push("## Timeline digest");
  if (brief.timeline.length === 0) lines.push("- (none)");
  for (const ev of brief.timeline) {
    lines.push(
      `- #${ev.seq} ${ev.kind} · ${ev.actorLabel}${ev.targetId ? ` · ${ev.targetId}` : ""}`,
    );
  }
  if (brief.memory) {
    lines.push("");
    lines.push("## Case memory summary");
    lines.push(`- known: ${brief.memory.boardCounts.known}`);
    lines.push(`- unknown: ${brief.memory.boardCounts.unknown}`);
    lines.push(`- agreed: ${brief.memory.boardCounts.agreed}`);
    lines.push(`- disputed: ${brief.memory.boardCounts.disputed}`);
    lines.push(`- newly concluded: ${brief.memory.boardCounts.newlyConcluded}`);
    lines.push(`- ${brief.memory.agreementNotice}`);
  }
  lines.push("");
  lines.push("## Involved entities");
  const involvement = brief.involvement ?? [];
  if (involvement.length === 0) lines.push("- (none recorded)");
  for (const row of involvement) {
    const when = row.occurredAt === null
      ? "when not recorded"
      : `${row.occurredAt}${row.occurredAtZone === "unspecified" ? " (time zone not recorded)" : ""}`;
    const disclosure = row.labelDisclosed ? "" : " · label withheld";
    lines.push(`- ${row.entityRef} · ${row.kind} · ${row.relationship} · ${row.state} · ${when}${disclosure}`);
  }

  lines.push("");
  lines.push("## Referenced investigations");
  const references = brief.references ?? [];
  if (references.length === 0) lines.push("- (none recorded)");
  for (const row of references) {
    const title = row.citedTitle ?? "title withheld";
    const note = row.note === "" ? "" : ` — ${row.note}`;
    lines.push(`- ${title} · ${row.resourceKind} · ${row.state} · ${row.locator}${note}`);
  }

  lines.push("");
  lines.push("## Resolution");
  if (!brief.resolution) {
    lines.push("- (not resolved)");
  } else {
    const resolution = brief.resolution;
    lines.push(`- basis: ${resolution.basis}`);
    lines.push(`- provenance: ${resolution.provenance}`);
    lines.push(`- revision: ${resolution.revision}`);
    lines.push(`- recorded by: ${resolution.actorLabel}`);
    lines.push(`- open unknowns: ${resolution.unknownCount}`);
    lines.push(
      resolution.rationaleIncluded
        ? `- rationale: ${resolution.rationale ?? ""}`
        : "- rationale: withheld from a share-safe export",
    );
    for (const unknown of resolution.unknowns ?? []) lines.push(`  - unknown: ${unknown}`);
  }

  lines.push("");
  lines.push("## Hypotheses");
  if (brief.hypotheses.length === 0) lines.push("- (none)");
  for (const h of brief.hypotheses) {
    const support = h.supporting.map((l) => `${l.kind}:${l.id}`).join(", ") || "none";
    const contra = h.contradicting.map((l) => `${l.kind}:${l.id}`).join(", ") || "none";
    lines.push(`- ${h.id} [${h.status}] ${h.body ?? "(redacted or tombstoned)"}`);
    lines.push(`  - source: ${h.sourceLabel}`);
    lines.push(`  - supporting: ${support}`);
    lines.push(`  - contradicting: ${contra}`);
  }
  lines.push("");
  lines.push("## Actions");
  if (brief.actions.length === 0) lines.push("- (none)");
  for (const a of brief.actions) {
    lines.push(`- ${a.id} · ${a.actorLabel} · ${a.body ?? "(redacted or tombstoned)"}`);
  }
  lines.push("");
  lines.push("## Evidence inventory");
  if (brief.evidence.length === 0) lines.push("- (none)");
  for (const e of brief.evidence) {
    lines.push(
      `- ${e.id} ${e.kind} ${e.filename ?? ""} hash=${e.contentHash ?? "none"} source=${e.sourceLabel} privacy=${e.privacyClass} verify=${e.verificationStatus ?? "n/a"} bytes=${e.bytesIncluded ? "included" : "omitted"}`,
    );
    if (e.content !== null) {
      lines.push("```");
      lines.push(line(e.content));
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("## Attributions");
  if (brief.attributions.length === 0) lines.push("- (none)");
  for (const a of brief.attributions) {
    lines.push(
      `- ${a.actorLabel} ${a.action} ${a.targetKind}${a.targetId ? `:${a.targetId}` : ""}`,
    );
  }
  lines.push("");
  lines.push("## Imported external responses (not findings)");
  if (brief.importedRuns.length === 0) lines.push("- (none)");
  for (const run of brief.importedRuns) {
    lines.push(
      `- ${run.id} presentation=${run.presentation} state=${run.corroborationState} source=${run.sourceLabel} snapshot=${run.snapshotBinding ?? "none"}`,
    );
    if (run.outputIncluded && run.outputText !== null) {
      lines.push("```");
      lines.push(line(run.outputText));
      lines.push("```");
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function packageMarkdown(pkg: PromptPackageV1): string {
  const lines: string[] = [];
  lines.push(`# Selected-evidence prompt package`);
  lines.push("");
  lines.push(`- schema: ${pkg.schemaId}`);
  lines.push(`- privacy: ${pkg.privacyClass}`);
  lines.push(`- case: ${pkg.caseId}`);
  lines.push(`- snapshot: ${pkg.snapshotIdentity}`);
  lines.push(`- excluded by default: ${pkg.manifest.excludedByDefault.join(", ")}`);
  lines.push("");
  lines.push("## Manifest");
  for (const item of pkg.manifest.items) {
    lines.push(`- ${item.kind}:${item.id} hash=${item.contentHash} privacy=${item.privacyClass}`);
  }
  lines.push("");
  lines.push("## Excerpts");
  if (pkg.excerpts.length === 0) lines.push("- (none)");
  for (const ex of pkg.excerpts) {
    lines.push(
      `- ${ex.kind}:${ex.id} source=${ex.sourceLabel} privacy=${ex.privacyClass} body=${ex.bodyIncluded ? "included" : "omitted"}`,
    );
    if (ex.content !== null) {
      lines.push("```");
      lines.push(line(ex.content));
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("## Prompt scaffold");
  if (pkg.promptScaffold === null) {
    lines.push("- (none)");
  } else {
    lines.push("```");
    lines.push(line(pkg.promptScaffold));
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}
