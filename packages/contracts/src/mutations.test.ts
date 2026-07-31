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
