import { describe, expect, it } from "vitest";
import type { LogCorpusSummaryDto } from "./host";
import {
  buildLogDiagnosticReport,
  LOG_DIAGNOSTIC_NOTE_MAX_CHARS,
  LOG_DIAGNOSTIC_REPORT_MAX_BYTES,
  type LogDiagnosticSuppressionPolicyInput,
} from "./logDiagnosticReport";

function privateCorpus(): LogCorpusSummaryDto {
  return {
    id: "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c",
    name: "Incident at private.internal with sk-abcdefghijk",
    eventCount: 25_000,
    templateCount: 412,
    engine: "duckdb",
    createdAt: 1_753_680_000,
    sourceLabel: "/Users/chris/Company/private-incident.log",
    stats: {
      files: 7,
      discoveredFiles: 10,
      excludedFiles: 1,
      failedFiles: 1,
      ignoredFiles: 1,
      exclusionCounts: {
        binary: 1,
        open_failed: 1,
        hidden: 1,
      },
      exclusionExamples: [
        "binary: /Users/chris/Company/core.bin",
        "open_failed: C:\\Company\\secret.log",
        "hidden: /home/engineer/.ignored.log",
      ],
      partial: true,
      lines: 25_000,
      templates: 412,
      reductionRatio: 60.7,
      embedded: 0,
      sourceBytes: 16_367_576,
      corpusBytes: 22_000_000,
      levelCounts: { info: 24_000, error: 1_000 },
      tsMin: 1_735_689_600,
      tsMax: 1_735_776_000,
      formatCounts: { json: 20_000, logfmt: 5_000 },
    },
    topTemplates: [
      {
        id: 1,
        pattern: "TOP_TEMPLATE_PRIVATE_PAYLOAD customer=secret",
        count: 1_000,
        severity: 5,
      },
    ],
    embedding: {
      state: "partial",
      modelId: "embarrassing-private-model",
      embeddedTemplates: 100,
      totalTemplates: 412,
      reason: "private-provider-reason",
      updatedAt: 1_753_680_100,
    },
  };
}

describe("buildLogDiagnosticReport", () => {
  it("exports only allowlisted corpus diagnostics and basename-only examples", () => {
    const report = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: "de43caeba66df05068a50db9356efad3b64a4a45",
        os: "macOS",
      },
      currentStatus: {
        kind: "error",
        message:
          "failed at /Users/chris/Company/private.log from 10.4.3.2 Bearer super-secret-token",
      },
      userNote:
        "Repro under /home/chris/work against private.internal using ghp_abcdefghijklmnopqrstuvwxyz",
      generatedAt: new Date("2026-07-28T12:00:00.000Z"),
    });

    expect(report.manifest.corpus?.stats?.basenameExamples).toEqual([
      "binary: core.bin",
      "open_failed: secret.log",
      "hidden: .ignored.log",
    ]);
    expect(report.manifest.corpus?.embedding).toEqual({ state: "partial" });
    expect(report.markdown).toContain("25,000".replace(",", ""));
    expect(report.markdown).toContain("json: 20000");
    expect(report.markdown).toContain("raw logs and event payloads");
    expect(report.json).toContain('"reviewRequired": true');

    const exported = `${report.markdown}\n${report.json}`;
    for (const forbidden of [
      "/Users/chris",
      "/home/chris",
      "C:\\Company",
      "10.4.3.2",
      "private.internal",
      "super-secret-token",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "TOP_TEMPLATE_PRIVATE_PAYLOAD",
      "private-incident.log",
      "embarrassing-private-model",
      "private-provider-reason",
    ]) {
      expect(exported).not.toContain(forbidden);
    }
  });

  it("caps notes, count maps, examples, status, and total serialized size", () => {
    const corpus = privateCorpus();
    if (!corpus.stats) throw new Error("fixture stats missing");
    corpus.stats.exclusionExamples = Array.from(
      { length: 100 },
      (_, index) => `reason_${index}: /Users/private/file-${index}.log`,
    );
    corpus.stats.levelCounts = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`level_${index}`, index + 1]),
    );

    const report = buildLogDiagnosticReport({
      corpus,
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "Linux",
      },
      currentStatus: { kind: "status", message: "s".repeat(10_000) },
      userNote: "n".repeat(10_000),
    });

    expect(Array.from(report.manifest.userNote ?? "")).toHaveLength(
      LOG_DIAGNOSTIC_NOTE_MAX_CHARS,
    );
    expect(report.manifest.currentStatus?.message.length).toBe(800);
    expect(report.manifest.corpus?.stats?.basenameExamples).toHaveLength(12);
    expect(
      Object.keys(report.manifest.corpus?.stats?.levelCounts ?? {}),
    ).toHaveLength(32);
    expect(
      new TextEncoder().encode(report.markdown).length,
    ).toBeLessThanOrEqual(LOG_DIAGNOSTIC_REPORT_MAX_BYTES);
    expect(new TextEncoder().encode(report.json).length).toBeLessThanOrEqual(
      LOG_DIAGNOSTIC_REPORT_MAX_BYTES,
    );
  });

  it("does not infer timestamp quality from stored scalar bounds", () => {
    const report = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "installed",
        gitSha: null,
        os: "Windows",
      },
    });

    expect(report.manifest.corpus?.stats?.timeQuality).toBe(
      "not_persisted_in_corpus_summary",
    );
    expect(report.markdown).not.toContain("wall clock");
  });

  it("exports a failed ingest without a corpus, raw error, or source identity", () => {
    const report = buildLogDiagnosticReport({
      failedIngest: {
        schemaVersion: 2,
        generatedAt: 1_753_680_000,
        sourceKind: "zip",
        reasonCode: "invalid_archive",
        summary:
          "The selected archive could not be validated; no corpus was published.",
        cancelled: false,
        progress: {
          lastPhase: "scan",
          linesProcessed: 0,
          filesProcessed: 12,
          bytesProcessed: 4096,
          templates: 0,
          updatesSeen: 4,
        },
        evidence: {
          scanCounts: {
            binary: 3,
            empty: 2,
            hidden: 1,
            oversized: 4,
            readFailed: 1,
            parseFailed: 1,
          },
          transcript: [
            { reason: "binary", basename: "core.bin" },
            {
              reason: "read_failed",
              basename:
                "/Users/employee/private.internal/Bearer top-secret-token.log",
            },
            {
              reason: "parse_failed",
              basename: "customer.private.log",
            },
          ],
          omittedEntries: 7,
        },
        redacted: true,
      },
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "macOS",
      },
      currentStatus: {
        kind: "error",
        message:
          "zip failed at /Users/employee/private.internal/secret.zip Bearer top-secret-token",
      },
      userNote:
        "Reproduced under /opt/company/logs on server.internal via 127.0.0.1, ::1, fd12:3456::7, and fe80::1",
    });

    expect(report.manifest.corpus).toBeNull();
    expect(report.manifest.failedIngest?.reasonCode).toBe("invalid_archive");
    expect(report.markdown).toContain("Corpus published: no");
    expect(report.markdown).toContain("binary: 3");
    expect(report.markdown).toContain("empty: 2");
    expect(report.markdown).toContain("read_failed: 1");
    expect(report.markdown).toContain("binary: core.bin");
    expect(report.markdown).toContain("7 additional observation(s) omitted");
    expect(report.manifest.failedIngest?.evidence.transcript).toEqual([
      { reason: "binary", basename: "core.bin" },
      { reason: "read_failed", basename: "[REDACTED_TOKEN]" },
      { reason: "parse_failed", basename: "[REDACTED-HOST]" },
    ]);
    expect(report.markdown).toContain(
      "cleared explicitly, by the next ingest attempt, or on app restart",
    );
    const exported = `${report.markdown}\n${report.json}`;
    for (const forbidden of [
      "/Users/employee",
      "private.internal",
      "secret.zip",
      "top-secret-token",
      "/opt/company",
      "server.internal",
      "127.0.0.1",
      "::1",
      "fd12:3456::7",
      "fe80::1",
    ]) {
      expect(exported).not.toContain(forbidden);
    }
  });

  it("independently re-bounds a hostile failed-ingest transcript", () => {
    const report = buildLogDiagnosticReport({
      failedIngest: {
        schemaVersion: 2,
        generatedAt: 1,
        sourceKind: "directory",
        reasonCode: "no_safe_events",
        summary: "No safe events.",
        cancelled: false,
        progress: {
          lastPhase: "parse",
          linesProcessed: 0,
          filesProcessed: 100,
          bytesProcessed: 0,
          templates: 0,
          updatesSeen: 100,
        },
        evidence: {
          scanCounts: {
            binary: 100,
            empty: 0,
            hidden: 0,
            oversized: 0,
            readFailed: 0,
            parseFailed: 0,
          },
          transcript: Array.from({ length: 100 }, (_, index) => ({
            reason: "binary" as const,
            basename: `/Users/private/parent-${index}/item-${index}.bin`,
          })),
          omittedEntries: 0,
        },
        redacted: true,
      },
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "Linux",
      },
    });

    expect(report.manifest.failedIngest?.evidence.transcript).toHaveLength(20);
    expect(report.manifest.failedIngest?.evidence.transcript[0]?.basename).toBe(
      "item-0.bin",
    );
    expect(report.manifest.failedIngest?.evidence.omittedEntries).toBe(80);
    expect(report.markdown).not.toContain("/Users/");
    expect(report.json).not.toContain("parent-99");
    expect(new TextEncoder().encode(report.json).length).toBeLessThanOrEqual(
      LOG_DIAGNOSTIC_REPORT_MAX_BYTES,
    );
  });

  it("bounds active Explorer state without exporting filter or source values", () => {
    const report = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "Linux",
      },
      activeView: {
        breakpoint: "ultrawide",
        density: "compact",
        rowMode: "wrap",
        metadataPresentation: "compact",
        fieldEmphasis: "payload",
        timeQuality: "wall",
        linkMode: "follow_cursor",
        visibleLaneCount: 2,
        laneSourceCounts: [3, 2],
        filters: {
          levelCount: 1,
          sourceCount: 2,
          serviceCount: 1,
          hostCount: 1,
          keywordPresent: true,
          tracePresent: true,
          timeFrom: 100,
          timeTo: 200,
          seqFrom: 10,
          seqTo: 999,
          templateId: 42,
        },
        find: {
          active: true,
          matchMode: "regex",
          caseSensitive: true,
          semantic: false,
          residentMatches: 50,
        },
        selectedSeqs: Array.from({ length: 80 }, (_, index) => 80 - index),
        highlightedSeqs: [12, 11],
        focusedSeq: 12,
        viewportAnchors: [
          { laneId: "lane-0", seq: 11 },
          { laneId: "lane-1", seq: 12 },
        ],
        filtersCollapsed: true,
        investigationCollapsed: false,
        uiState: {
          category: "active",
          busy: false,
          hasError: false,
        },
      },
      currentStatus: {
        kind: "status",
        message:
          "Filter: keyword “customer-private-filter” · source api/private-source.log",
      },
    });

    expect(report.manifest.activeView?.selectedSeqs).toHaveLength(32);
    expect(report.manifest.currentStatus).toBeNull();
    expect(report.manifest.activeView?.selectedSeqs[0]).toBe(1);
    expect(report.markdown).toContain("Filter values withheld");
    const exported = `${report.markdown}\n${report.json}`;
    for (const forbidden of [
      "customer@example.internal",
      "trace-private-value",
      "customer-private-filter",
      "api/private-source.log",
      "private-host.internal",
    ]) {
      expect(exported).not.toContain(forbidden);
    }
    expect(new TextEncoder().encode(report.json).length).toBeLessThanOrEqual(
      LOG_DIAGNOSTIC_REPORT_MAX_BYTES,
    );
  });

  it("exports a bounded payload-free suppression policy without representatives or preview identities", () => {
    const rules: Array<
      LogDiagnosticSuppressionPolicyInput["rules"][number] & {
        representative: string;
        previewToken: string;
        sourcePath: string;
      }
    > = Array.from({ length: 40 }, (_, index) => ({
      ruleId: `019fab76-18ff-7361-8dd8-${(index + 1)
        .toString(16)
        .padStart(12, "0")}`,
      name:
        index === 0
          ? "Noisy rule for private.internal"
          : `Bounded rule ${index}`,
      rationale:
        index === 0
          ? "Hide /Users/chris/private.log with Bearer top-secret-token"
          : `Confirmed repetitive family ${index}`,
      state: index === 1 ? ("enabled" as const) : ("disabled" as const),
      resolutionKind:
        index === 1 ? ("stale_target_missing" as const) : ("inactive" as const),
      matchingEventCount: 0,
      representative: "RAW_PRIVATE_EVENT",
      previewToken: "fixture-preview-token",
      sourcePath: "/Users/chris/private.log",
    }));
    rules[0] = {
      ...rules[0],
      state: "enabled",
      resolutionKind: "matches_current",
      matchingEventCount: 12_452,
    };
    const audit = Array.from({ length: 70 }, (_, index) => ({
      action: index % 2 === 0 ? ("previewed" as const) : ("activated" as const),
      revision: index + 1,
      ruleId: index % 2 === 0 ? null : "019fab76-18ff-7361-8dd8-000000000001",
      createdAt: 1_753_680_000 + index,
      previewToken: `private-preview-${index}`,
      rawPayload: `private-payload-${index}`,
    }));

    const report = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "macOS",
      },
      suppressionPolicy: {
        policyRevision: 70,
        resolvedTemplateRevision: 9,
        enabledRuleCount: 2,
        appliedRuleCount: 1,
        staleRuleCount: 1,
        rules,
        audit,
      },
    });

    expect(report.manifest.suppressionPolicy?.rules).toHaveLength(32);
    expect(report.manifest.suppressionPolicy?.audit).toHaveLength(64);
    expect(report.manifest.suppressionPolicy?.omittedRuleEntries).toBe(8);
    expect(report.manifest.suppressionPolicy?.omittedAuditEntries).toBe(6);
    expect(report.manifest.suppressionPolicy?.audit[0]?.revision).toBe(7);
    expect(report.markdown).toContain("Rules: 2 enabled / 1 applied / 1 stale");
    expect(report.markdown).toContain("stale_target_missing");
    expect(report.markdown).toContain(
      "8 additional rule entry/entries omitted",
    );
    expect(report.markdown).toContain("6 older audit entry/entries omitted");

    const exported = `${report.markdown}\n${report.json}`;
    for (const forbidden of [
      "private.internal",
      "/Users/chris",
      "top-secret-token",
      "RAW_PRIVATE_EVENT",
      "private-preview",
      "private-payload",
      '"representative":',
      "previewToken",
      "rawPayload",
      "sourcePath",
    ]) {
      expect(exported).not.toContain(forbidden);
    }
  });

  it("forces zero matches for every non-applying rule even when a caller claims otherwise (#819)", () => {
    const report = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "macOS",
      },
      suppressionPolicy: {
        policyRevision: 4,
        resolvedTemplateRevision: 2,
        enabledRuleCount: 4,
        appliedRuleCount: 1,
        staleRuleCount: 3,
        rules: [
          {
            ruleId: "019fab76-18ff-7361-8dd8-00000000000a",
            name: "applying",
            rationale: "reviewed noise",
            state: "enabled",
            resolutionKind: "matches_current",
            matchingEventCount: 12_452,
          },
          // A renderer claiming a stale rule still hides evidence.
          {
            ruleId: "019fab76-18ff-7361-8dd8-00000000000b",
            name: "stale target",
            rationale: "target gone",
            state: "enabled",
            resolutionKind: "stale_target_missing",
            matchingEventCount: 9_999,
          },
          {
            ruleId: "019fab76-18ff-7361-8dd8-00000000000c",
            name: "fingerprint changed",
            rationale: "template changed",
            state: "enabled",
            resolutionKind: "stale_fingerprint_changed",
            matchingEventCount: 7,
          },
          // A disabled rule with a matching kind must still report zero.
          {
            ruleId: "019fab76-18ff-7361-8dd8-00000000000d",
            name: "disabled",
            rationale: "turned off",
            state: "disabled",
            resolutionKind: "inactive",
            matchingEventCount: 5,
          },
        ],
        audit: [],
      },
    });

    const rules = report.manifest.suppressionPolicy?.rules ?? [];
    expect(rules).toHaveLength(4);
    for (const rule of rules) {
      if (
        rule.resolutionKind === "matches_current" &&
        rule.state === "enabled"
      ) {
        expect(rule.matchingEventCount).toBe(12_452);
      } else {
        expect(rule.matchingEventCount).toBe(0);
      }
    }
  });

  it("keeps suppression diagnostics absent for legacy and failed-ingest reports", () => {
    const legacy = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "Linux",
      },
    });
    expect(legacy.manifest.suppressionPolicy).toBeNull();
    expect(legacy.markdown).not.toContain("Suppression policy");

    const failed = buildLogDiagnosticReport({
      failedIngest: {
        schemaVersion: 2,
        generatedAt: 1,
        sourceKind: "directory",
        reasonCode: "cancelled",
        summary: "Cancelled before publication.",
        cancelled: true,
        progress: {
          lastPhase: "parse",
          linesProcessed: 1,
          filesProcessed: 1,
          bytesProcessed: 1,
          templates: 0,
          updatesSeen: 1,
        },
        evidence: {
          scanCounts: {
            binary: 0,
            empty: 0,
            hidden: 0,
            oversized: 0,
            readFailed: 0,
            parseFailed: 0,
          },
          transcript: [],
          omittedEntries: 0,
        },
        redacted: true,
      },
      suppressionPolicy: {
        policyRevision: 1,
        resolvedTemplateRevision: 1,
        enabledRuleCount: 0,
        appliedRuleCount: 0,
        staleRuleCount: 0,
        rules: [],
        audit: [],
      },
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "Linux",
      },
    });
    expect(failed.manifest.suppressionPolicy).toBeNull();
  });
});
