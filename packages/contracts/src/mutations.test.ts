import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse";
import { loadFixture } from "./fixtureLoader";
import { FIXTURE_PARSERS } from "./wireV1";

/** JS integer just past the safe range — a u64 the wire may not carry. */
const UNSAFE = 2 ** 53;

type Mutation = { label: string; apply: (root: any) => void };

/**
 * Every mutation must make the family parser THROW `ContractViolation`.
 * Together they prove the validators reject renamed, deleted, and extra
 * fields, wrong enum values, numeric overflow, null/absent confusion, and
 * malformed nested values — type assertions alone would catch none of these.
 */
const MUTATIONS: Record<string, Mutation[]> = {
  "event.v1.json": [
    { label: "delete kind", apply: (r) => delete r[0].kind },
    { label: "rename kind", apply: (r) => { r[0].kindRenamed = r[0].kind; delete r[0].kind; } },
    { label: "extra field", apply: (r) => { r[0].unexpected = 1; } },
    { label: "wrong type kind", apply: (r) => { r[0].kind = 7; } },
    { label: "missing payload", apply: (r) => delete r[0].payload },
  ],
  "explorer_event.v1.json": [
    { label: "delete seq", apply: (r) => delete r.seq },
    { label: "rename seq", apply: (r) => { r.sequence = r.seq; delete r.seq; } },
    { label: "extra field", apply: (r) => { r.unexpected = true; } },
    { label: "bogus timeQuality", apply: (r) => { r.timeQuality = "bogus"; } },
    { label: "seq overflow", apply: (r) => { r.seq = UNSAFE; } },
    { label: "negative seq", apply: (r) => { r.seq = -1; } },
    { label: "skipped-optional null", apply: (r) => { r.unresolvedLocalTimestamp = null; } },
    { label: "wrong casing", apply: (r) => { r.template_id = r.templateId; delete r.templateId; } },
  ],
  "event_page.v1.json": [
    { label: "delete totalMatched", apply: (r) => delete r.totalMatched },
    { label: "totalMatched overflow", apply: (r) => { r.totalMatched = UNSAFE; } },
    { label: "nested event bogus basis", apply: (r) => { r.events[0].activeTimestampBasis = "wall"; } },
    { label: "extra field", apply: (r) => { r.extra = []; } },
  ],
  "event_rows_page.v1.json": [
    { label: "delete nextCursor (nullable is not omittable)", apply: (r) => delete r.nextCursor },
    { label: "totalMatched must not exist", apply: (r) => { r.totalMatched = 1; } },
    { label: "nested malformed event", apply: (r) => { r.events[0].level = 5; } },
  ],
  "event_count.v1.json": [
    { label: "delete totalMatched", apply: (r) => delete r.totalMatched },
    { label: "overflow", apply: (r) => { r.totalMatched = UNSAFE; } },
    { label: "extra field", apply: (r) => { r.total = 1; } },
  ],
  "log_facets.v1.json": [
    { label: "delete timeQuality", apply: (r) => delete r.timeQuality },
    { label: "map value wrong type", apply: (r) => { r.sources["api.log"] = "many"; } },
    { label: "map value overflow", apply: (r) => { r.levels.ERROR = UNSAFE; } },
    { label: "extra field", apply: (r) => { r.facets = {}; } },
  ],
  "shared_timeline_summary.v1.json": [
    { label: "delete buckets", apply: (r) => delete r.buckets },
    { label: "bogus severity", apply: (r) => { r.severitySeries[0].severity = "fatal"; } },
    { label: "overflow totalMatched", apply: (r) => { r.totalMatched = UNSAFE; } },
    { label: "lane extra field", apply: (r) => { r.lanes[0].label = "x"; } },
  ],
  "suppression_document.v1.json": [
    { label: "bogus rule state", apply: (r) => { r.rules[0].state = "paused"; } },
    { label: "bogus resolution kind", apply: (r) => { r.rules[0].resolution.kind = "best_effort"; } },
    { label: "resolution boolean drift", apply: (r) => { r.rules[0].resolution.matchesNothing = "false"; } },
    { label: "delete predicate", apply: (r) => delete r.rules[0].predicate },
    { label: "audit extra field", apply: (r) => { r.audit[0].actor = "me"; } },
    { label: "revision overflow", apply: (r) => { r.revision = UNSAFE; } },
    { label: "resolved template overflow", apply: (r) => { r.resolvedTemplateRevision = UNSAFE; } },
    { label: "bogus origin", apply: (r) => { r.previews[0].origin = "agent"; } },
  ],
  "noise_candidate_report.v1.json": [
    { label: "bogus shape", apply: (r) => { r.candidates[0].shape = "spiky"; } },
    { label: "delete disclaimer", apply: (r) => delete r.disclaimer },
    { label: "eventCount overflow", apply: (r) => { r.candidates[0].eventCount = UNSAFE; } },
    { label: "bogus reason code", apply: (r) => { r.candidates[0].reasonCodes[0] = "vibes"; } },
    { label: "nullable span wrong type", apply: (r) => { r.candidates[0].wallTimeSpan = 5; } },
  ],
  "investigation_document.v1.json": [
    { label: "bogus finding kind", apply: (r) => { r.findings[0].kind = "decision"; } },
    { label: "bogus finding policy lens", apply: (r) => { r.findings[0].policyBinding.noiseLens = "revealed"; } },
    { label: "delete evidence eventRefs", apply: (r) => delete r.evidence[0].eventRefs },
    { label: "delete proposed queue", apply: (r) => delete r.proposedFindings },
    { label: "bogus proposal status", apply: (r) => { r.proposedFindings[0].status = "auto_accepted"; } },
    { label: "bogus proposal evidence role", apply: (r) => { r.proposedFindings[0].evidence[0].role = "neutral"; } },
    { label: "bogus proposal source", apply: (r) => { r.proposedFindings[0].provenance.source = "unknown"; } },
    { label: "proposal rank overflow", apply: (r) => { r.proposedFindings[0].rankInputs.supportingCount = UNSAFE; } },
    { label: "bogus linkMode", apply: (r) => { r.findings[0].viewRecipe.linkMode = "aligned"; } },
    { label: "revision overflow", apply: (r) => { r.revision = UNSAFE; } },
    { label: "bogus provenance", apply: (r) => { r.findings[0].provenance = "model"; } },
    { label: "recipe extra field", apply: (r) => { r.findings[0].viewRecipe.zoom = 2; } },
    { label: "delete reportSections", apply: (r) => delete r.reportSections },
    { label: "delete proposedReportSections", apply: (r) => delete r.proposedReportSections },
    { label: "bogus report section kind", apply: (r) => { r.reportSections[0].kind = "scope"; } },
    { label: "report section bogus provenance", apply: (r) => { r.reportSections[0].provenance = "model"; } },
    { label: "report section skipped-optional citations null", apply: (r) => { r.reportSections[1].evidenceIds = null; } },
    { label: "report section extra field", apply: (r) => { r.reportSections[0].markdown = "# authored"; } },
    { label: "bogus proposed report section status", apply: (r) => { r.proposedReportSections[0].status = "auto_accepted"; } },
    { label: "proposed report section bogus source", apply: (r) => { r.proposedReportSections[0].provenance.source = "unknown"; } },
    { label: "proposed report section missing idempotencyKey", apply: (r) => delete r.proposedReportSections[0].idempotencyKey },
    { label: "proposed report section acceptance wrong type", apply: (r) => { r.proposedReportSections[1].acceptance.edited = "yes"; } },
    { label: "proposed report section snake_case drift", apply: (r) => { r.proposedReportSections[2].dismiss_reason = r.proposedReportSections[2].dismissReason; delete r.proposedReportSections[2].dismissReason; } },
  ],
  "investigation_report.v1.json": [
    { label: "delete scope", apply: (r) => delete r.scope },
    { label: "delete sections", apply: (r) => delete r.sections },
    { label: "delete timeline", apply: (r) => delete r.timeline },
    { label: "bogus status", apply: (r) => { r.status = "closed"; } },
    { label: "sourceRevision overflow", apply: (r) => { r.sourceRevision = UNSAFE; } },
    { label: "skipped-optional currentPolicy null", apply: (r) => { r.currentPolicy = null; } },
    { label: "currentPolicy sha wrong type", apply: (r) => { r.currentPolicy.effectivePolicySha256 = 7; } },
    { label: "currentPolicy bogus noise lens", apply: (r) => { r.currentPolicy.noiseLens = "hidden"; } },
    { label: "scope timeWindow flag wrong type", apply: (r) => { r.scope.timeWindow.mixedQuality = "no"; } },
    { label: "sections unknown slot", apply: (r) => { r.sections.incidentScope = { body: "derived" }; } },
    { label: "authored section delete body", apply: (r) => delete r.sections.executiveSummary.body },
    { label: "accepted proposal provenance bogus source", apply: (r) => { r.sections.executiveSummary.acceptedProposalProvenance.source = "unknown"; } },
    { label: "bogus finding policyBindingStatus", apply: (r) => { r.findings[0].policyBindingStatus = "fresh"; } },
    { label: "bogus citation reference status", apply: (r) => { r.findings[0].citations[0].references[0].status = "gone"; } },
    { label: "timeline bogus status", apply: (r) => { r.timeline.entries[0].status = "legacy_range"; } },
    { label: "timeline omittedCount negative", apply: (r) => { r.timeline.omittedCount = -1; } },
    { label: "timeline seq overflow", apply: (r) => { r.timeline.entries[0].seq = UNSAFE; } },
    { label: "generatedAt wrong type", apply: (r) => { r.generatedAt = "2026-07-31"; } },
    { label: "extra root field", apply: (r) => { r.markdown = "# rendered"; } },
    { label: "camelCase drift", apply: (r) => { r.source_revision = r.sourceRevision; delete r.sourceRevision; } },
  ],
  "resolved_bookmark.v1.json": [
    { label: "bogus evidenceStatus", apply: (r) => { r[0].evidenceStatus = "fresh"; } },
    { label: "delete id", apply: (r) => delete r[0].id },
    { label: "legacy extra field", apply: (r) => { r[1].bookmark = {}; } },
    { label: "eventRef seq overflow", apply: (r) => { r[0].eventRefs[0].seq = UNSAFE; } },
  ],
  "process_progress.v1.json": [
    { label: "bogus phase", apply: (r) => { r[0].phase = "uploading"; } },
    { label: "bogus kind", apply: (r) => { r[0].kind = "logIngest"; } },
    { label: "fraction out of range", apply: (r) => { r[1].fraction = 1.5; } },
    { label: "counter overflow", apply: (r) => { r[1].bytes_processed = UNSAFE; } },
    { label: "elapsed overflow", apply: (r) => { r[0].elapsed_ms = UNSAFE; } },
    { label: "negative phase elapsed", apply: (r) => { r[0].phase_elapsed_ms = -1; } },
    { label: "delete cancellable", apply: (r) => delete r[0].cancellable },
    { label: "camelCase drift", apply: (r) => { r[0].linesProcessed = r[0].lines_processed; delete r[0].lines_processed; } },
  ],
  "import_preview_report.v1.json": [
    { label: "delete status", apply: (r) => delete r.items[0].status },
    { label: "bogus status", apply: (r) => { r.items[0].status = "probably_fine"; } },
    { label: "bogus reason", apply: (r) => { r.items[0].reasons[0] = "looks_ok"; } },
    { label: "bogus role", apply: (r) => { r.items[0].role = "logs"; } },
    { label: "bogus sourceKind", apply: (r) => { r.sourceKind = "folder"; } },
    { label: "bytes overflow", apply: (r) => { r.items[0].bytes = UNSAFE; } },
    { label: "delete selected", apply: (r) => delete r.items[0].selected },
    { label: "selected wrong type", apply: (r) => { r.items[0].selected = "yes"; } },
    { label: "delete counts", apply: (r) => delete r.counts },
    { label: "counts overflow", apply: (r) => { r.counts.total = UNSAFE; } },
    { label: "extra field", apply: (r) => { r.unexpected = 1; } },
    { label: "snake_case drift", apply: (r) => { r.items[0].format_id = r.items[0].formatId; delete r.items[0].formatId; } },
    { label: "skipped-optional null", apply: (r) => { r.items[0].representative = null; } },
    { label: "group member wrong type", apply: (r) => { r.groups[0].memberIdentities = "logs/app.jsonl.1"; } },
    { label: "delete possibleOverlap", apply: (r) => delete r.groups[0].possibleOverlap },
  ],
  "import_preview_plan.v1.json": [
    { label: "delete planToken", apply: (r) => delete r.planToken },
    { label: "planToken wrong type", apply: (r) => { r.planToken = 42; } },
    { label: "delete planVersion", apply: (r) => delete r.planVersion },
    { label: "planVersion overflow", apply: (r) => { r.planVersion = UNSAFE; } },
    { label: "delete report", apply: (r) => delete r.report },
    { label: "nested report drift", apply: (r) => { r.report.items[0].status = "fine"; } },
    { label: "extra field", apply: (r) => { r.tail = []; } },
  ],
  "import_profile.v1.json": [
    { label: "delete schemaId", apply: (r) => delete r.schemaId },
    { label: "delete profileId", apply: (r) => delete r.profileId },
    { label: "version overflow", apply: (r) => { r.version = UNSAFE; } },
    { label: "bogus role", apply: (r) => { r.sourceGroups[0].role = "logfile"; } },
    { label: "include wrong type", apply: (r) => { r.sourceGroups[0].include = "logs/**"; } },
    { label: "delete include", apply: (r) => delete r.sourceGroups[0].include },
    { label: "profile ref missing version", apply: (r) => delete r.sourceGroups[0].formatProfile.version },
    { label: "extra field", apply: (r) => { r.executable = "rm -rf /"; } },
    { label: "extra group field", apply: (r) => { r.sourceGroups[0].script = "eval()"; } },
    { label: "snake_case drift", apply: (r) => { r.source_groups = r.sourceGroups; delete r.sourceGroups; } },
    { label: "empty-segment pattern is not a schema concern but id must exist", apply: (r) => delete r.schemaId },
  ],
  "profile_match_report.v1.json": [
    { label: "delete clean", apply: (r) => delete r.clean },
    { label: "delete applicability", apply: (r) => delete r.applicability },
    { label: "bogus applicability", apply: (r) => { r.applicability = "probably"; } },
    { label: "bogus finding kind", apply: (r) => { r.findings[0].kind = "ok"; } },
    { label: "bogus finding reason", apply: (r) => { r.findings[0].reason = "seems_right"; } },
    { label: "delete digest", apply: (r) => delete r.profile.digest },
    { label: "profile version overflow", apply: (r) => { r.profile.version = UNSAFE; } },
    { label: "proposedRoles bogus value", apply: (r) => { r.proposedRoles["logs/app.jsonl.1"] = "everything"; } },
    { label: "extra field", apply: (r) => { r.applied = true; } },
    { label: "delete findings", apply: (r) => delete r.findings },
  ],
  "reviewed_format.v1.json": [
    { label: "delete schemaId", apply: (r) => delete r.schemaId },
    { label: "delete formatId", apply: (r) => delete r.formatId },
    { label: "bogus multiline", apply: (r) => { r.multiline = "sometimes"; } },
    { label: "priority overflow", apply: (r) => { r.priority = UNSAFE; } },
    { label: "layout wrong type", apply: (r) => { r.layout = "message"; } },
    { label: "layout slot outside the closed vocabulary", apply: (r) => { r.layout[0] = "exec"; } },
    { label: "layout slot with two keys", apply: (r) => { r.layout[3] = { logger: {}, thread: {} }; } },
    { label: "timestamp token outside the closed vocabulary", apply: (r) => { r.timestamp.tokens[0] = "year5"; } },
    { label: "timestamp token object with wrong key", apply: (r) => { r.timestamp.tokens[1] = { regex: ".*" }; } },
    { label: "delete timestamp", apply: (r) => delete r.timestamp },
    { label: "extra field (a format is not code)", apply: (r) => { r.exec = "rm -rf /"; } },
    { label: "snake_case drift", apply: (r) => { r.format_id = r.formatId; delete r.formatId; } },
  ],
  "reviewed_format_preview.v1.json": [
    { label: "delete needsTimezoneReview", apply: (r) => delete r.needsTimezoneReview },
    { label: "delete linesDropped", apply: (r) => delete r.linesDropped },
    { label: "delete formatValid", apply: (r) => delete r.formatValid },
    { label: "formatValid wrong type", apply: (r) => { r.formatValid = 1; } },
    { label: "linesDropped overflow", apply: (r) => { r.linesDropped = UNSAFE; } },
    { label: "needsTimezoneReview wrong type", apply: (r) => { r.needsTimezoneReview = "yes"; } },
    { label: "bogus provenance", apply: (r) => { r.provenance = "probably_utc"; } },
    { label: "recordsMatched overflow", apply: (r) => { r.recordsMatched = UNSAFE; } },
    { label: "sample missing message", apply: (r) => delete r.samples[0].fields.message },
    { label: "sample bogus provenance", apply: (r) => { r.samples[0].fields.provenance = "guessed"; } },
    { label: "extra field", apply: (r) => { r.applied = true; } },
  ],
  "model_options.v1.json": [
    { label: "delete provider identity", apply: (r) => delete r[0].provider_id },
    { label: "bogus availability", apply: (r) => { r[0].availability = "available"; } },
    { label: "pinned rank overflow", apply: (r) => { r[0].pinned_rank = UNSAFE; } },
    { label: "nullable detail wrong type", apply: (r) => { r[0].availability_detail = 7; } },
    { label: "hidden flag wrong type", apply: (r) => { r[0].hidden = "false"; } },
    { label: "extra field", apply: (r) => { r[0].provider = "legacy"; } },
  ],
};

describe("cd.v1 mutation coverage — every corruption must be rejected", () => {
  it("covers every fixture in the manifest", () => {
    expect(Object.keys(MUTATIONS).sort()).toEqual(
      Object.keys(FIXTURE_PARSERS).sort(),
    );
  });

  for (const [name, mutations] of Object.entries(MUTATIONS)) {
    const parse = FIXTURE_PARSERS[name];
    describe(name, () => {
      it("baseline parses before mutation", () => {
        expect(() => parse(loadFixture(name))).not.toThrow();
      });
      for (const mutation of mutations) {
        it(`rejects: ${mutation.label}`, () => {
          const value = loadFixture(name) as any;
          mutation.apply(value);
          expect(() => parse(value)).toThrow(ContractViolation);
        });
      }
    });
  }
});
