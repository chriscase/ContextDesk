import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIVE_PROFILE_ALIASES,
  QUALIFICATION_CAVEATS,
  QUALIFICATION_REPORT_SCHEMA_ID,
  parseLabExportV2,
  parseLabImport,
  parseQualificationReport,
  scanShareSafePrivacy,
  type QualificationBackend,
  type QualificationReportV1,
  type QualificationStepV1,
} from "@cd-collab/contracts";
import type { Actor, CaseService } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import {
  DEFAULT_HOST_LANE_CONCURRENCY,
  exerciseHostLaneContracts,
  runFakeHostLanes,
} from "./host-lanes.js";
import { inspectLiveProfiles } from "./live.js";

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
  if (!artifacts.some((row) => row.contentHash === uploaded.artifact.contentHash)) {
    throw new Error("frozen evidence inventory missing uploaded hash");
  }
  steps.push({
    id: "freeze_evidence",
    status: "passed",
    note: "content-addressed inventory verified",
  });

  const hostPackage = loadJson("experiment-package.valid.json") as {
    packageId: string;
    snapshotFingerprint: string;
    taskFingerprint: string;
    candidates: Array<{ candidateId: string; modelLabel: string }>;
  };
  const lanes = await runFakeHostLanes({
    snapshotFingerprint: hostPackage.snapshotFingerprint,
    lanes: hostPackage.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      modelLabel: candidate.modelLabel,
    })),
    maxConcurrency: DEFAULT_HOST_LANE_CONCURRENCY,
    deadlineMs: 5_000,
  });
  const sameSnapshot = lanes.results.every(
    (row) => row.snapshotFingerprint === hostPackage.snapshotFingerprint,
  );
  if (!sameSnapshot || lanes.maxActive > DEFAULT_HOST_LANE_CONCURRENCY) {
    throw new Error("host lanes violated same-snapshot or concurrency bounds");
  }
  steps.push({
    id: "host_owned_lanes",
    status: "passed",
    note: `fake host connector lanes completed max_active=${lanes.maxActive}`,
  });

  const interrupts = await exerciseHostLaneContracts(hostPackage.snapshotFingerprint);
  steps.push({
    id: "host_lane_interrupts",
    status: "passed",
    note: `cancel=${interrupts.cancelled} deadline=${interrupts.deadline} partial=${interrupts.partial}`,
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
  const remappedChat = structuredClone(loadJson("interaction-trace.chat.json")) as {
    candidateId: string;
  };
  remappedChat.candidateId = "cand-qwen-3.6-27b";
  await deps.experiments.importTrace(
    created.id,
    hostView.id,
    actor,
    remappedChat,
    origin,
    true,
  );
  steps.push({
    id: "import_external_chat",
    status: "passed",
    note: "external strategy package plus a remapped chat trace on a host lane",
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
  try {
    parseLabImport(exported);
    throw new Error("lab export must not parse as an import envelope");
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not parse")) throw error;
  }
  const reimported = await deps.experiments.importEnvelope(
    created.id,
    actor,
    hostPackage,
    origin,
    true,
  );
  if (reimported.id !== hostView.id) {
    throw new Error("share-safe package re-import was not idempotent");
  }
  try {
    await deps.experiments.importEnvelope(created.id, actor, exported, origin, true);
    throw new Error("lab export must not import as an envelope");
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not import")) throw error;
  }
  const poisons: Array<Record<string, string>> = [
    { prompt: "system override" },
    { api_key: "sk-test" },
    { endpoint: "https://gateway.example.test/v1" },
    { request_id: "req-abc123xyz" },
    { rawCapture: "unredacted model output" },
  ];
  for (const extra of poisons) {
    const label = Object.keys(extra)[0] ?? "poison";
    try {
      await deps.experiments.importEnvelope(
        created.id,
        actor,
        { ...hostPackage, ...extra },
        origin,
        true,
      );
      throw new Error(`poisoned import must fail closed (${label})`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("must fail closed")) throw error;
    }
  }
  steps.push({
    id: "export_share_safe",
    status: "passed",
    note: "export scanned; re-import idempotent; poison rejected",
  });

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
  steps.push({
    id: "lineage_rerun",
    status: "passed",
    note: "newer profile package imported on the same case",
  });

  const host = await deps.experiments.get(created.id, hostView.id, actor, true);
  const chat = await deps.experiments.get(created.id, chatView.id, actor, true);
  if (!host || !chat) throw new Error("experiments missing after lineage");

  const unknownCount = host.alignments.filter((row) => row.status === "unknown").length;
  const report: QualificationReportV1 = {
    schemaId: QUALIFICATION_REPORT_SCHEMA_ID,
    privacyClass: "share_safe",
    backend,
    steps,
    concurrency: {
      configuredLimit: DEFAULT_HOST_LANE_CONCURRENCY,
      observedMaxActive: lanes.maxActive,
      sameSnapshot,
      durableRunCount: new Set(lanes.results.map((row) => row.durableRunId)).size,
    },
    comparison: {
      sharedEvidenceCount: host.agreement.sharedAnchors.length,
      uniqueEvidenceCount: host.agreement.candidateSpecific.reduce(
        (sum, row) => sum + row.evidenceRefs.length,
        0,
      ),
      disagreementCount: host.agreement.roleConflicts.length,
      unknownCount,
      questionPathCount: chat.comparison.questionPaths.length,
      helpfulnessRecorded: host.observations.length > 0,
      goldAligned: host.alignments.some((row) => row.status !== "unknown"),
      acceptedDecision: host.decisions.some((row) => row.status === "accepted"),
    },
    lineage: {
      predecessorPackageAlias: hostView.packageId,
      successorPackageAlias: v2.packageId,
      goldVersion: gold2.version,
      predecessorGoldPresent: Boolean(gold.goldId),
    },
    liveProfiles: inspectLiveProfiles(deps.liveEnv ?? {}),
    caveats: [...QUALIFICATION_CAVEATS],
  };
  if (report.liveProfiles.length !== LIVE_PROFILE_ALIASES.length) {
    throw new Error("live profile matrix is incomplete");
  }
  return parseQualificationReport(report);
}
