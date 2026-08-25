/**
 * Human identity for one recorded evidence reference.
 *
 * The War Room is read by triage engineers and IT support staff, not by the
 * people who chose the identifiers. A reference like `ev-demo-checkout-log` is
 * an address, not a name, so every surface that shows evidence needs a name a
 * reader can hold in their head and tell apart from the next one.
 *
 * Two rules constrain that naming, and both come from real defects this module
 * exists to fix:
 *
 * 1. **Distinct references never collapse into one identity.** The previous
 *    fallback returned the first trace event that cited a reference *and* had
 *    an excerpt. A single recorded step often cites several references at once,
 *    so every reference in that step resolved to the same label, the same
 *    source, and the same excerpt — the cross-examination table rendered two
 *    different artifacts as identical rows, one "cited as symptom" and one
 *    "cited as cause", with no way to tell which was which.
 *
 * 2. **Attribution is never narrowed to one arbitrary lane.** That same
 *    fallback named whichever lane's trace happened to be stored first, so a
 *    lane's own path card described its evidence as "cited by" a different
 *    lane.
 *
 * Nothing here reconstructs facts the record does not carry. A name derived
 * from the reference is always reported as derived, so a reader can tell an
 * uploaded filename from a readable rendering of an identifier.
 */

/** The evidence-board artifact fields these projections read. */
export interface EvidenceArtifactFacts {
  id: string;
  kind: string;
  filename: string | null;
  uri: string | null;
  mediaType: string | null;
  privacyClass: string;
  verificationStatus: string | null;
}

/** One recorded step of a lane's interaction trace. */
export interface EvidenceTraceEvent {
  sequence: number;
  kind: string;
  actor: string;
  authorUsername?: string;
  excerpt: string | null;
  evidenceRefs: string[];
}

/** One lane's recorded trace, already resolved to a human lane name. */
export interface EvidenceTraceFacts {
  candidateId: string;
  events: EvidenceTraceEvent[];
}

export interface EvidenceIdentityContext {
  artifacts: EvidenceArtifactFacts[];
  traces: EvidenceTraceFacts[];
  /** Maps a lane id to the name shown to readers. */
  laneName: (candidateId: string) => string;
  /** Text loaded from the evidence board, keyed by reference. */
  loadedText?: Record<string, { text: string; truncated: boolean }>;
  /**
   * The lane whose surface is being rendered. When this lane cites the
   * reference its own recorded excerpt is preferred, so a path card never
   * quotes a different lane back at the reader.
   */
  preferLane?: string | null;
}

/** Where a displayed name came from, so a derived name is never mistaken for a filename. */
export type EvidenceNameOrigin = "artifact" | "derived-from-reference";

/** Where a displayed excerpt came from. */
export type EvidenceExcerptOrigin = "evidence-board" | "lane-trace" | "none";

export interface EvidenceIdentity {
  /** The reference itself. Kept for addressing and progressive disclosure. */
  reference: string;
  /** The name shown to a reader. Distinct references always get distinct names. */
  name: string;
  nameOrigin: EvidenceNameOrigin;
  /** One line describing where this evidence comes from. */
  source: string;
  /** Readable text, when the record actually carries some. */
  excerpt: string | null;
  excerptOrigin: EvidenceExcerptOrigin;
  /**
   * What the excerpt is and is not. When a recorded step cited several
   * references together, this says so rather than implying the text describes
   * this reference alone.
   */
  excerptCaveat: string | null;
  /** Every lane whose recorded trace cites this reference, in lane order. */
  citedByLanes: string[];
  /** True when no artifact and no trace text back this reference. */
  unresolved: boolean;
}

/** Strip the `ev-`/`evidence-` address prefix; it is a type tag, not content. */
function withoutReferencePrefix(reference: string): string {
  return reference.replace(/^(?:ev|evidence|artifact|art)[-_]/i, "");
}

/**
 * Render an identifier as readable words.
 *
 * This is a presentation of the identifier the record already carries, not an
 * inference about the artifact behind it, so callers must pair it with
 * `nameOrigin: "derived-from-reference"`.
 */
export function readableReferenceName(reference: string): string {
  const words = withoutReferencePrefix(reference)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return reference;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Prefer a real filename, then a URI basename, then the artifact kind. */
export function artifactName(artifact: EvidenceArtifactFacts): string | null {
  const filename = artifact.filename?.trim();
  if (filename) return filename;
  const uri = artifact.uri?.trim();
  if (uri) {
    const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri;
    const basename = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1);
    if (basename) return basename;
  }
  const kind = artifact.kind.replaceAll("_", " ").trim();
  return kind ? `${kind} evidence` : null;
}

function artifactSourceLine(artifact: EvidenceArtifactFacts): string {
  return [
    artifact.kind.replaceAll("_", " "),
    artifact.verificationStatus?.replaceAll("_", " ") ?? "verification unknown",
    artifact.privacyClass.replaceAll("_", " "),
  ].join(" · ");
}

/**
 * Choose the recorded step that best evidences one reference.
 *
 * A step citing this reference alone describes it exactly; a step citing it
 * alongside others describes them jointly. Prefer the exact one, and prefer the
 * lane being rendered over any other, so attribution is never arbitrary.
 */
function bestTraceEvidence(
  reference: string,
  context: EvidenceIdentityContext,
): { trace: EvidenceTraceFacts; event: EvidenceTraceEvent; sole: boolean } | null {
  const matches: { trace: EvidenceTraceFacts; event: EvidenceTraceEvent; sole: boolean }[] = [];
  for (const trace of context.traces) {
    for (const event of trace.events) {
      if (!event.evidenceRefs.includes(reference)) continue;
      if (!event.excerpt?.trim()) continue;
      matches.push({ trace, event, sole: event.evidenceRefs.length === 1 });
    }
  }
  if (!matches.length) return null;
  const preferred = context.preferLane;
  const rank = (match: (typeof matches)[number]): number => {
    const ownLane = preferred && match.trace.candidateId === preferred ? 0 : 1;
    const soleRank = match.sole ? 0 : 1;
    // Own lane first so a path card quotes itself; an exact single-reference
    // step next, because it describes this reference and nothing else.
    return ownLane * 2 + soleRank;
  };
  return [...matches].sort((left, right) => rank(left) - rank(right))[0] ?? null;
}

/** Every lane whose recorded trace cites this reference, in stored lane order. */
export function lanesCiting(reference: string, context: EvidenceIdentityContext): string[] {
  const lanes: string[] = [];
  for (const trace of context.traces) {
    if (!trace.events.some((event) => event.evidenceRefs.includes(reference))) continue;
    const name = context.laneName(trace.candidateId);
    if (!lanes.includes(name)) lanes.push(name);
  }
  return lanes;
}

/**
 * Resolve one evidence reference to a human identity.
 *
 * The returned identity is a function of the reference and the record alone:
 * the same reference always resolves the same way for a given lane, and two
 * different references never resolve to the same name.
 */
export function evidenceIdentity(
  reference: string,
  context: EvidenceIdentityContext,
): EvidenceIdentity {
  const artifact = context.artifacts.find((row) => row.id === reference);
  const loaded = context.loadedText?.[reference];
  const citedByLanes = lanesCiting(reference, context);
  const traceMatch = bestTraceEvidence(reference, context);

  if (artifact) {
    const name = artifactName(artifact) ?? readableReferenceName(reference);
    if (loaded) {
      return {
        reference,
        name,
        nameOrigin: "artifact",
        source: artifactSourceLine(artifact),
        excerpt: loaded.text,
        excerptOrigin: "evidence-board",
        excerptCaveat: loaded.truncated
          ? "Shown text is a bounded excerpt of the stored artifact."
          : null,
        citedByLanes,
        unresolved: false,
      };
    }
    if (traceMatch) {
      return {
        reference,
        name,
        nameOrigin: "artifact",
        source: artifactSourceLine(artifact),
        excerpt: traceMatch.event.excerpt,
        excerptOrigin: "lane-trace",
        excerptCaveat: jointCitationCaveat(traceMatch, context, name),
        citedByLanes,
        unresolved: false,
      };
    }
    return {
      reference,
      name,
      nameOrigin: "artifact",
      source: artifactSourceLine(artifact),
      excerpt: null,
      excerptOrigin: "none",
      excerptCaveat: `${name} is on the evidence board, but no readable excerpt was loaded here.`,
      citedByLanes,
      unresolved: false,
    };
  }

  // No artifact on the board. Name the reference readably and say so plainly,
  // rather than borrowing an unrelated lane's identity for it.
  const derivedName = readableReferenceName(reference);
  if (traceMatch) {
    return {
      reference,
      name: derivedName,
      nameOrigin: "derived-from-reference",
      source: citedByLanes.length
        ? `named from the recorded reference · cited in ${citedByLanes.join(", ")}`
        : "named from the recorded reference",
      excerpt: traceMatch.event.excerpt,
      excerptOrigin: "lane-trace",
      excerptCaveat: jointCitationCaveat(traceMatch, context, derivedName),
      citedByLanes,
      unresolved: false,
    };
  }
  return {
    reference,
    name: derivedName,
    nameOrigin: "derived-from-reference",
    source: citedByLanes.length
      ? `named from the recorded reference · cited in ${citedByLanes.join(", ")}`
      : "named from the recorded reference · no attached artifact",
    excerpt: null,
    excerptOrigin: "none",
    excerptCaveat:
      "No excerpt, timestamp, or component was recorded for this reference. ContextDesk will not reconstruct them from an identifier.",
    citedByLanes,
    unresolved: true,
  };
}

/**
 * Say what a borrowed excerpt actually covers.
 *
 * A step citing several references describes them together. Presenting its text
 * as this one reference's content would overstate the record, so the caveat
 * names the lane, the step, and how many references the step cited.
 */
function jointCitationCaveat(
  match: { trace: EvidenceTraceFacts; event: EvidenceTraceEvent; sole: boolean },
  context: EvidenceIdentityContext,
  name: string,
): string {
  const lane = context.laneName(match.trace.candidateId);
  if (match.sole) {
    return `Recorded by ${lane} at step ${match.event.sequence}, citing ${name} on its own.`;
  }
  const others = match.event.evidenceRefs.length - 1;
  return `Recorded by ${lane} at step ${match.event.sequence}, which cited ${name} together with ${others} other reference${others === 1 ? "" : "s"}. The text covers that step, not ${name} alone.`;
}

/**
 * Disambiguate names across a set of references.
 *
 * Two artifacts can legitimately share a filename, and two references can read
 * the same after prefix stripping. Readers still have to tell them apart, so a
 * repeated name gains a short, stable suffix taken from the reference itself.
 */
export function disambiguateIdentities(identities: EvidenceIdentity[]): EvidenceIdentity[] {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    counts.set(identity.name, (counts.get(identity.name) ?? 0) + 1);
  }
  return identities.map((identity) => {
    if ((counts.get(identity.name) ?? 0) < 2) return identity;
    const tail = withoutReferencePrefix(identity.reference).slice(-8);
    return { ...identity, name: `${identity.name} (${tail})` };
  });
}
