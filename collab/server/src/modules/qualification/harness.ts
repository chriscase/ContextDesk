import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIVE_PROFILE_ALIASES,
  QUALIFICATION_CAVEATS,
  QUALIFICATION_REPORT_SCHEMA_ID,
  parseLabExportV2,
  parseQualificationReport,
  type QualificationBackend,
  type QualificationReportV1,
  type QualificationStepV1,
} from "@cd-collab/contracts";
import { scanShareSafePrivacy } from "@cd-collab/contracts";
import type { Actor, CaseService } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import { FakeHostConnector, inspectLiveProfiles } from "../jobs/index.js";
import { ComparisonJobRunner } from "../jobs/index.js";
import type { JobStore } from "../jobs/index.js";
import { MemoryJobStore } from "../jobs/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../../contracts/fixtures");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
}

const LOG = Buffer.from(
  "2026-08-18T06:59:58Z INFO checkout started\n2026-08-18T06:59:59Z ERROR database timeout\n",
);

export interface QualificationDeps {
  cases: CaseService;
  experiments: ExperimentService;
  jobs?: JobStore;
  backend?: QualificationBackend;
  liveEnv?: NodeJS.ProcessEnv;
}

export async function runQualification(
  deps: QualificationDeps,
): Promise<QualificationReportV1> {
  const steps: QualificationStepV1[] = [];
  const actor: Actor = {
    id: "uid=qual,ou=people,dc=example,dc=test",
    username: "qual",
  };
  const origin = "qualification";
  const jobs = deps.jobs ?? new MemoryJobStore();
  const backend = deps.backend ?? "memory";

  const created = await deps.cases.createCase(
    actor,
    { title: "Qualification checkout timeouts", clientTime: "2026-08-18T07:00:00Z" },
    origin,
  );
  steps.push({ id: "start_case", status: "passed", note: "case created" });

  const uploaded = await deps.cases.addEvidence(
    created.id,
    actor,
    {
      kind: "log",
      filename: "checkout.log",
      mediaType: "text/plain",
      bytes: LOG,
      summary: "checkout log freeze",
      privacyClass: "share_safe",
    },
    origin,
  );
  const artifacts = await deps.cases.listArtifacts(created.id, actor, true);
  const hashes = artifacts
    .map((row) => row.contentHash)
    .filter((hash): hash is string => typeof hash === "string")
    .sort();
  if (hashes.length === 0 || hashes[0] !== uploaded.artifact.contentHash) {
    throw new Error("frozen evidence inventory is empty");
  }
  const snapshotFingerprint = `snap-${createHash("sha256").update(hashes.join("|")).digest("hex")}`;
  steps.push({
    id: "freeze_evidence",
    status: "passed",
    note: "content-addressed inventory verified",
  });

  const connector = new FakeHostConnector({
    "cand-gpt-oss-120b": { delayMs: 25, evidenceRefs: ["ev-demo-checkout-log", "ev-demo-pool-exhaustion"] },
    "cand-qwen-3.6-27b": { delayMs: 35, evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"] },
    "cand-ministral-14b": { delayMs: 15, evidenceRefs: ["ev-demo-checkout-log"] },
  });
  const runner = new ComparisonJobRunner(jobs, connector, "qual-worker");
  const hostPackage = loadJson("experiment-package.valid.json") as {
    schemaId: string;
    packageId: string;
    taskFingerprint: string;
    snapshotFingerprint: string;
    candidates: Array<{ candidateId: string; modelLabel: string }>;
  };
  const comparison = await runner.run({
    snapshotFingerprint,
    taskFingerprint: hostPackage.taskFingerprint,
    lanes: hostPackage.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      modelLabel: candidate.modelLabel,
      profileAlias: candidate.modelLabel,
    })),
    deadlineMs: 5_000,
    maxConcurrency: 2,
  });
  if (comparison.stopped !== "none") {
    throw new Error(`host comparison stopped: ${comparison.stopped}`);
  }
  steps.push({
    id: "host_owned_triage",
    status: "passed",
    note: "synthetic host connector lanes completed",
  });
  steps.push({
    id: "bounded_comparison",
    status: connector.maxActive <= 2 ? "passed" : "failed",
    note: `max_active=${connector.maxActive}`,
  });

  const hostView = await deps.experiments.importEnvelope(
    created.id,
    actor,
    hostPackage,
    origin,
    true,
  );
  const again = await deps.experiments.importEnvelope(
    created.id,
    actor,
    hostPackage,
    origin,
    true,
  );
  if (again.id !== hostView.id) {
    throw new Error("host package import was not idempotent");
  }
  steps.push({ id: "import_host_package", status: "passed", note: "idempotent host package" });

  const chatView = await deps.experiments.importEnvelope(
    created.id,
    actor,
    loadJson("strategy-package.diverge.json"),
    origin,
    true,
  );
  const againChat = await deps.experiments.importEnvelope(
    created.id,
    actor,
    loadJson("strategy-package.diverge.json"),
    origin,
    true,
  );
  if (againChat.id !== chatView.id) {
    throw new Error("external strategy import was not idempotent");
  }
  steps.push({
    id: "import_external_chat",
    status: "passed",
    note: "external strategy package with a different question path",
  });

  await deps.experiments.recordHelpfulness(
    created.id,
    hostView.id,
    actor,
    {
      candidateId: "cand-qwen-3.6-27b",
      dimension: "evidence_support",
      score: 2,
      rationale: "cited the checkout log",
      evidenceRefs: ["ev-demo-checkout-log"],
    },
    origin,
    true,
  );
  const proposed = await deps.experiments.proposeDecision(
    created.id,
    hostView.id,
    actor,
    {
      text: "inventory timeout is the leading candidate",
      rationale: "shared checkout symptom plus unique inventory evidence",
      evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    },
    origin,
    true,
  );
  const accepted = await deps.experiments.acceptDecision(
    created.id,
    hostView.id,
    actor,
    proposed.revision,
    origin,
    true,
  );
  const gold = await deps.experiments.promoteGold(
    created.id,
    hostView.id,
    actor,
    {
      decisionId: accepted.id,
      expectedRevision: accepted.revision,
      evidenceAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      expectedRelationships: [
        { evidenceRef: "ev-demo-checkout-log", role: "symptom" },
        { evidenceRef: "ev-demo-inventory-timeout", role: "cause" },
      ],
    },
    origin,
    true,
  );
  steps.push({
    id: "compare_and_decide",
    status: "passed",
    note: "helpfulness, accepted decision, and gold recorded",
  });

  const exported = await deps.experiments.exportShareSafe(created.id, hostView.id, actor, true);
  parseLabExportV2(exported);
  const leaks = scanShareSafePrivacy(exported);
  if (leaks.length > 0) {
    throw new Error(`share-safe export leaked ${leaks.map((item) => item.rule).join(",")}`);
  }
  steps.push({ id: "export_share_safe", status: "passed", note: "lab export v2 scanned clean" });

  const v2raw = structuredClone(hostPackage);
  v2raw.packageId = "pkg-synth-three-model-checkout-v2";
  v2raw.candidates = v2raw.candidates.map((candidate) => ({
    ...candidate,
    modelLabel: `${candidate.modelLabel}:v2`,
  }));
  const v2 = await deps.experiments.importEnvelope(created.id, actor, v2raw, origin, true);
  const proposed2 = await deps.experiments.proposeDecision(
    created.id,
    v2.id,
    actor,
    {
      text: "inventory timeout remains the leading candidate after profile refresh",
      rationale: "same snapshot, newer profile labels",
      evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    },
    origin,
    true,
  );
  const accepted2 = await deps.experiments.acceptDecision(
    created.id,
    v2.id,
    actor,
    proposed2.revision,
    origin,
    true,
  );
  const gold2 = await deps.experiments.promoteGold(
    created.id,
    v2.id,
    actor,
    {
      decisionId: accepted2.id,
      expectedRevision: accepted2.revision,
      evidenceAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      expectedRelationships: [
        { evidenceRef: "ev-demo-checkout-log", role: "symptom" },
        { evidenceRef: "ev-demo-inventory-timeout", role: "cause" },
      ],
    },
    origin,
    true,
  );
  if (gold2.version < 1) throw new Error("successor gold missing");
  steps.push({
    id: "lineage_rerun",
    status: "passed",
    note: "newer profile package imported; gold lineage preserved on the successor experiment",
  });

  const host = await deps.experiments.get(created.id, hostView.id, actor, true);
  if (!host) throw new Error("host experiment missing after lineage");
  const chat = await deps.experiments.get(created.id, chatView.id, actor, true);
  if (!chat) throw new Error("chat experiment missing");

  const report: QualificationReportV1 = {
    schemaId: QUALIFICATION_REPORT_SCHEMA_ID,
    privacyClass: "share_safe",
    backend,
    steps,
    comparison: {
      sharedEvidenceCount: host.agreement.sharedAnchors.length,
      uniqueEvidenceCount: host.agreement.candidateSpecific.reduce(
        (sum, row) => sum + row.evidenceRefs.length,
        0,
      ),
      disagreementCount: host.agreement.roleConflicts.length,
      questionPathCount: chat.comparison.questionPaths.length,
      helpfulnessRecorded: host.observations.length > 0,
      goldAligned: host.alignments.some((row) => row.status !== "unknown"),
      acceptedDecision: host.decisions.some((row) => row.status === "accepted"),
    },
    lineage: {
      predecessorPackageAlias: hostView.packageId,
      successorPackageAlias: v2.packageId,
      goldVersion: gold2.version,
      predecessorGoldPresent: gold.goldId !== gold2.goldId,
    },
    liveProfiles: inspectLiveProfiles(deps.liveEnv ?? {}).map((profile) => ({
      alias: profile.alias,
      configured: profile.configured,
      ran: false,
      skippedReason: profile.configured
        ? "opt_in_host_not_invoked_in_hermetic_suite"
        : "credentials_not_configured",
    })),
    caveats: [...QUALIFICATION_CAVEATS],
  };
  if (report.liveProfiles.length !== LIVE_PROFILE_ALIASES.length) {
    throw new Error("live profile matrix is incomplete");
  }
  return parseQualificationReport(report);
}
