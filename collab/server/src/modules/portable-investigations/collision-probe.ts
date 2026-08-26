/**
 * Archive-scoped, host-owned destination collision probing for portable apply.
 *
 * The destination key for every minted namespace is
 * `portableDestinationUuid(sourceInstallationId, namespace, sourceId, rung)`,
 * a deterministic function of the archive alone. So the only ids that can
 * collide are the ids this archive would mint, and the host can settle
 * collisions by asking its own stores about exactly those ids. It never has to
 * enumerate the destination corpus, and the cost of a preflight follows the
 * size of the archive rather than the size of the installation.
 *
 * Three properties this module has to keep:
 *
 * - **Host-owned.** Every occupied id in the resulting catalog came from a
 *   store this server owns. A client-supplied catalog is never an input, and
 *   an occupied key is never authorization. Object-key probes are deliberately
 *   not actor-filtered: an object the caller cannot see still occupies its key,
 *   and the answer discloses only that this archive's own deterministic id is
 *   taken. Identity lookups are the opposite case and stay inside the caller's
 *   existing view — see `probeParticipants`.
 * - **Bounded.** One batched round trip per probe kind per ladder rung, and the
 *   ladder is capped by `MAX_DETERMINISTIC_REMAP_ATTEMPTS`. Rung 0 is probed
 *   for every minted source id; a rung above 0 is probed only for the ids whose
 *   previous rung came back occupied.
 * - **Fail-closed.** A rung is escalated only after the previous rung is known
 *   to be occupied, so the deterministic remap in the contract can never land
 *   on an id the host has not cleared. Exhausting the ladder raises rather than
 *   silently reusing a key.
 */
import {
  MAX_DETERMINISTIC_REMAP_ATTEMPTS,
  PORTABLE_OBJECT_KINDS,
  portableDestinationUuid,
  portableMintsDestinationId,
  type PortableInvestigationV1,
  type PortableObjectKind,
} from "@cd-collab/contracts";
import type { CaseProbeKind, CaseStore } from "../cases/index.js";
import type { CatalogStore } from "../catalog/index.js";
import type { ExperimentProbeKind, ExperimentStore } from "../experiments/index.js";
import type { RunStore } from "../import/index.js";
import type { TriageJobStore } from "../triage-runs/index.js";

/** Stores that own a globally keyed destination table. */
export interface PortableCollisionProbePorts {
  cases: CaseStore;
  catalog: CatalogStore;
  experiments: ExperimentStore;
  runs: RunStore;
  jobs: TriageJobStore;
}

/**
 * Why a namespace is or is not probed. Every `PortableObjectKind` appears here
 * exactly once, so adding a kind without deciding its collision scope is a
 * compile error rather than a silently unprobed key.
 */
type NamespaceProbe =
  | { probe: "cases"; kind: CaseProbeKind }
  | { probe: "experiments"; kind: ExperimentProbeKind }
  | { probe: "catalog" }
  | { probe: "runs" }
  | { probe: "jobs" }
  | { probe: "none"; because: string };

const NAMESPACE_PROBES: Readonly<Record<PortableObjectKind, NamespaceProbe>> = Object.freeze({
  investigation: { probe: "cases", kind: "case" },
  contribution: { probe: "cases", kind: "contribution" },
  evidence: { probe: "cases", kind: "artifact" },
  attachment: { probe: "cases", kind: "artifact" },
  snapshot: { probe: "cases", kind: "snapshot" },
  intake_batch: { probe: "cases", kind: "intake_batch" },
  source: { probe: "catalog" },
  imported_ai_run: { probe: "runs" },
  triage_job: { probe: "jobs" },
  experiment: { probe: "experiments", kind: "experiment" },
  helpfulness: { probe: "experiments", kind: "helpfulness" },
  gold: { probe: "experiments", kind: "gold" },
  content: {
    probe: "none",
    because: "content is addressed by digest; an equal digest is deduplication, not a collision",
  },
  timeline: {
    probe: "none",
    because: "the destination assigns a fresh per-case sequence on append",
  },
  actor: {
    probe: "none",
    because: "historical actors are attribution strings, never a keyed destination identity row",
  },
  decision: {
    probe: "none",
    because: "decisions are keyed by (experiment, revision) under a freshly keyed experiment",
  },
  alignment: {
    probe: "none",
    because: "alignments are derived from their experiment and never keyed independently",
  },
  discussion: {
    probe: "none",
    because: "a discussion container is derived from its investigation id",
  },
  audit: {
    probe: "none",
    because: "audit references are appended with destination-assigned ids",
  },
});

/** Namespaces whose destination key this host actually probes. */
export const PROBED_PORTABLE_NAMESPACES: readonly PortableObjectKind[] = Object.freeze(
  PORTABLE_OBJECT_KINDS.filter((kind) => NAMESPACE_PROBES[kind].probe !== "none"),
);

/** Documented reason a namespace is structurally unable to collide. */
export function unprobedNamespaceReason(kind: PortableObjectKind): string | null {
  const entry = NAMESPACE_PROBES[kind];
  return entry.probe === "none" ? entry.because : null;
}

function sourceIdsByNamespace(
  bundle: PortableInvestigationV1,
): Map<PortableObjectKind, string[]> {
  const ids = new Map<PortableObjectKind, string[]>();
  const put = (kind: PortableObjectKind, values: Iterable<string>): void => {
    ids.set(kind, [...new Set(values)].sort());
  };
  put("investigation", [bundle.investigation.id]);
  put("contribution", bundle.contributions.map((row) => row.id));
  put("evidence", bundle.evidence.map((row) => row.id));
  put("attachment", bundle.attachments.map((row) => row.id));
  put("snapshot", bundle.snapshots.map((row) => row.id));
  put("source", bundle.sources.map((row) => row.id));
  put("imported_ai_run", bundle.importedAiRuns.map((row) => row.id));
  put("triage_job", bundle.triageJobs.map((row) => row.id));
  put("experiment", bundle.experiments.map((row) => row.id));
  put("helpfulness", bundle.helpfulnessObservations.map((row) => row.id));
  put("gold", bundle.gold.map((row) => row.goldId));
  return ids;
}

async function probeOccupied(
  ports: PortableCollisionProbePorts,
  namespace: PortableObjectKind,
  candidates: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const entry = NAMESPACE_PROBES[namespace];
  switch (entry.probe) {
    case "cases":
      return ports.cases.probeExistingIds(entry.kind, candidates);
    case "experiments":
      return ports.experiments.probeExistingIds(entry.kind, candidates);
    case "catalog":
      return ports.catalog.probeExistingIds(candidates);
    case "runs":
      return ports.runs.probeExistingIds(candidates);
    case "jobs":
      return ports.jobs.probeExistingIds(candidates);
    case "none":
      return [];
  }
}

export interface PortableCollisionProbeResult {
  /** Occupied destination ids, per namespace, sorted and deduplicated. */
  occupiedByNamespace: Partial<Record<PortableObjectKind, string[]>>;
  /** Store round trips spent. Bounded by probe kinds times ladder depth. */
  probeCalls: number;
  /** Deepest ladder rung any namespace had to reach. */
  deepestRung: number;
}

/**
 * Probes the destination for the deterministic ids `bundle` would mint.
 *
 * Rung 0 is probed for every minted source id in one batch per namespace. A
 * higher rung is probed only for the ids whose previous rung came back
 * occupied, which is the exact ladder the contract's deterministic remap walks.
 * The result carries only ids the host confirmed occupied, so a caller can
 * hand it to `preflightPortableArchive` as destination evidence without the
 * catalog ever describing an unrelated object.
 */
export async function probePortableCollisions(
  bundle: PortableInvestigationV1,
  ports: PortableCollisionProbePorts,
  options: { maxRungs?: number } = {},
): Promise<PortableCollisionProbeResult> {
  const maxRungs = Math.max(
    1,
    Math.min(options.maxRungs ?? MAX_DETERMINISTIC_REMAP_ATTEMPTS, MAX_DETERMINISTIC_REMAP_ATTEMPTS),
  );
  const sourceIds = sourceIdsByNamespace(bundle);
  const occupiedByNamespace: Partial<Record<PortableObjectKind, string[]>> = {};
  let probeCalls = 0;
  let deepestRung = 0;

  const namespaces = PORTABLE_OBJECT_KINDS.filter(
    (kind) =>
      portableMintsDestinationId(kind) &&
      NAMESPACE_PROBES[kind].probe !== "none" &&
      (sourceIds.get(kind)?.length ?? 0) > 0,
  );

  const perNamespace = await Promise.all(
    namespaces.map(async (kind) => {
      const occupied = new Set<string>();
      // Ids still climbing the ladder because their current rung is taken.
      let climbing = sourceIds.get(kind) ?? [];
      let calls = 0;
      let rung = 0;
      for (; rung < maxRungs && climbing.length > 0; rung += 1) {
        const candidates = climbing.map((sourceId) =>
          portableDestinationUuid(bundle.sourceInstallationId, kind, sourceId, rung),
        );
        const hits = new Set(await probeOccupied(ports, kind, candidates));
        calls += 1;
        if (hits.size === 0) break;
        for (const hit of hits) occupied.add(hit);
        climbing = climbing.filter((sourceId) =>
          hits.has(portableDestinationUuid(bundle.sourceInstallationId, kind, sourceId, rung)),
        );
      }
      return { kind, occupied: [...occupied].sort(), calls, rung };
    }),
  );

  for (const row of perNamespace) {
    probeCalls += row.calls;
    deepestRung = Math.max(deepestRung, row.rung);
    if (row.occupied.length > 0) occupiedByNamespace[row.kind] = row.occupied;
  }
  return { occupiedByNamespace, probeCalls, deepestRung };
}

/** A destination key this apply intended to write is already taken. */
export class PortableDestinationOccupiedError extends Error {
  constructor(
    readonly namespace: PortableObjectKind,
    readonly destinationId: string,
  ) {
    super(`destination id for ${namespace} is already occupied`);
    this.name = "PortableDestinationOccupiedError";
  }
}

/**
 * Fails closed when any id this report will write is already keyed.
 *
 * Preflight settles collisions before the apply transaction opens, so this is
 * the guard against a writer that took a key in between. It re-probes only the
 * exact destination ids in `idRemap` — bounded by archive size, one batched
 * call per probe kind — and raises on the first occupied key so the surrounding
 * transaction rolls back rather than overwriting someone else's row.
 *
 * It also holds memory and PostgreSQL to the same contract: a PostgreSQL
 * primary key would reject the second write, and the memory stores that would
 * otherwise overwrite a map entry now reject it here for the same reason.
 */
export async function assertDestinationIdsUnoccupied(
  report: { idRemap: ReadonlyArray<{ namespace: PortableObjectKind; destinationId: string }> },
  ports: PortableCollisionProbePorts,
): Promise<void> {
  const byNamespace = new Map<PortableObjectKind, Set<string>>();
  for (const row of report.idRemap) {
    if (!portableMintsDestinationId(row.namespace)) continue;
    if (NAMESPACE_PROBES[row.namespace].probe === "none") continue;
    const bucket = byNamespace.get(row.namespace) ?? new Set<string>();
    bucket.add(row.destinationId);
    byNamespace.set(row.namespace, bucket);
  }
  for (const [namespace, ids] of byNamespace) {
    const occupied = await probeOccupied(ports, namespace, [...ids].sort());
    const first = occupied[0];
    if (first !== undefined) {
      throw new PortableDestinationOccupiedError(namespace, first);
    }
  }
}
