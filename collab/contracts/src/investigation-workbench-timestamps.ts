/**
 * Host timestamp overlay for the Log workbench.
 *
 * The overlay joins host/cd-core event stamps back onto intake lines. The join
 * has to be content-based because the two sides share no key: the host knows
 * `source`/`message`, intake knows `evidenceId`/`lineNumber`. The shipped join
 * compared every line against every unconsumed stamp and re-derived the same
 * folded forms on each comparison, so it cost O(lines x stamps) folds. At the
 * 50,000-line read limit that is minutes of uninterrupted synchronous work, and
 * because it ran on the event loop it stalled every other request on the box.
 *
 * This module keeps the join predicate byte-for-byte and makes it near-linear:
 *
 *   - Stamps are folded **once** into an index instead of once per line.
 *   - `sourceOk` is exactly final-path-segment equality (see
 *     {@link sourceMatchKey}), so a line only ever considers stamps from its
 *     own file rather than the whole corpus.
 *   - Stamps that match identically are collapsed into one class, so duplicate
 *     host text costs one verification rather than one per copy.
 *   - The three substring rules are answered from rolling-hash gram indexes
 *     whose window width is the *shortest* needle they will be asked for, so no
 *     stamp falls outside the index and no rule degrades to a scan over stamps.
 *
 * Work is therefore bounded by the bytes read, not by lines x stamps.
 * {@link applyHostTimestampsChunked} additionally yields to the event loop on a
 * bounded cadence and honours cancellation, so one investigation's overlay can
 * neither stall another request nor outlive the request that asked for it.
 *
 * Nothing here interprets a timestamp. A zone is never guessed: a line only
 * gains a normalized UTC instant when the host reports wall-clock quality for
 * the stamp that claimed it.
 */
import type { HostEventStampV1, WorkbenchLine } from "./investigation-workbench.js";

export const HOST_TIMESTAMP_OVERLAY_LIMITS = {
  /** Widest gram window. Narrower windows are used when a needle is shorter. */
  maxGramWidth: 8,
  /** Lines overlaid between event-loop yields. */
  defaultChunkLines: 512,
  /** Prefilter table size; a power of two so the mask is a single AND. */
  gramFilterSlots: 1 << 14,
} as const;

/** Raised when an overlay is abandoned before it produced a complete result. */
export class HostTimestampOverlayCancelledError extends Error {
  constructor(message = "host timestamp overlay cancelled") {
    super(message);
    this.name = "HostTimestampOverlayCancelledError";
  }
}

/** The subset of `AbortSignal` this module needs; `AbortSignal` satisfies it. */
export interface OverlayAbortLike {
  readonly aborted: boolean;
}

export interface HostTimestampOverlayOptions {
  /** Lines overlaid between yields. Smaller keeps latency lower. */
  chunkLines?: number;
  /** Checked at every chunk boundary; an aborted overlay produces nothing. */
  signal?: OverlayAbortLike;
  /** Called at chunk boundaries with lines completed and the total. */
  onProgress?: (completed: number, total: number) => void;
  /** Overridable for deterministic tests. */
  yieldTo?: () => Promise<void>;
}

/**
 * Fold used by the third substring rule. Kept verbatim from the shipped
 * predicate: lowercase, digit runs to a single `#`, whitespace runs to one
 * space. Callers fold once per string rather than once per comparison.
 */
export function foldForMatch(value: string): string {
  return value.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
}

/**
 * The key that decides whether a stamp may claim a line at all.
 *
 * The shipped predicate accepted four relations between `stamp.source` and
 * `line.relativePath`: equality, either being a trailing path suffix of the
 * other, or equal final segments. The first three each force the two final
 * segments to be equal, and the fourth *is* that equality, so the disjunction
 * is exactly final-segment equality after backslash normalization. Bucketing on
 * this key is therefore a reformulation of the predicate, not a narrowing of
 * it — {@link hostTimestampSourceMatch} keeps the original form so the
 * equivalence can be asserted directly rather than assumed.
 */
export function sourceMatchKey(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? normalized : normalized.slice(cut + 1);
}

/** The shipped four-disjunct source relation, kept for equivalence testing. */
export function hostTimestampSourceMatch(source: string, relativePath: string): boolean {
  const left = source.replace(/\\/g, "/");
  const right = relativePath.replace(/\\/g, "/");
  return (
    left === right
    || right.endsWith(`/${left}`)
    || left.endsWith(`/${right}`)
    || left.split("/").pop() === right.split("/").pop()
  );
}

// ---------------------------------------------------------------------------
// Rolling-hash gram index
// ---------------------------------------------------------------------------

const HASH_BASE = 131;
const FILTER_MASK = HOST_TIMESTAMP_OVERLAY_LIMITS.gramFilterSlots - 1;

function hashWindow(value: string, start: number, width: number): number {
  let hash = 0;
  for (let i = 0; i < width; i += 1) {
    hash = (Math.imul(hash, HASH_BASE) + value.charCodeAt(start + i)) | 0;
  }
  return hash;
}

/**
 * Maps a fixed-width character window onto the classes whose needle could start
 * there. Hash collisions are harmless: every hit is verified against the real
 * string before it is allowed to match.
 */
interface GramIndex {
  width: number;
  /** 131^(width-1), for sliding a window forward in constant time. */
  dropFactor: number;
  buckets: Map<number, number[]>;
  /** Rejects most windows without touching the map. */
  filter: Uint8Array;
  /** Smallest stamp index reachable through this index, for early exit. */
  minStampIndex: number;
}

function createGramIndex(width: number): GramIndex {
  let dropFactor = 1;
  for (let i = 1; i < width; i += 1) dropFactor = Math.imul(dropFactor, HASH_BASE) | 0;
  return {
    width,
    dropFactor,
    buckets: new Map(),
    filter: new Uint8Array(HOST_TIMESTAMP_OVERLAY_LIMITS.gramFilterSlots),
    minStampIndex: Number.MAX_SAFE_INTEGER,
  };
}

function addGram(index: GramIndex, hash: number, classId: number, stampIndex: number): void {
  index.filter[hash & FILTER_MASK] = 1;
  const existing = index.buckets.get(hash);
  if (existing === undefined) index.buckets.set(hash, [classId]);
  else if (existing[existing.length - 1] !== classId) existing.push(classId);
  if (stampIndex < index.minStampIndex) index.minStampIndex = stampIndex;
}

/** Index a class by the first `width` characters of its needle. */
function indexNeedlePrefix(
  index: GramIndex,
  needle: string,
  classId: number,
  stampIndex: number,
): void {
  if (needle.length < index.width) return;
  addGram(index, hashWindow(needle, 0, index.width), classId, stampIndex);
}

/** Index a class by every `width`-wide window of a haystack it owns. */
function indexHaystackWindows(
  index: GramIndex,
  haystack: string,
  classId: number,
  stampIndex: number,
): void {
  const width = index.width;
  if (haystack.length < width) return;
  let hash = hashWindow(haystack, 0, width);
  addGram(index, hash, classId, stampIndex);
  for (let i = width; i < haystack.length; i += 1) {
    hash =
      (Math.imul(hash - Math.imul(index.dropFactor, haystack.charCodeAt(i - width)), HASH_BASE)
        + haystack.charCodeAt(i))
      | 0;
    addGram(index, hash, classId, stampIndex);
  }
}

// ---------------------------------------------------------------------------
// Index model
// ---------------------------------------------------------------------------

/**
 * Stamps that agree on (source key, trimmed local timestamp, trimmed message)
 * match exactly the same lines, because those are the only stamp fields the
 * predicate reads. Collapsing them keeps duplicate host text from costing one
 * verification per copy while preserving the greedy order: members are held in
 * ascending stamp order and consumed from the front.
 */
interface OverlayClass {
  members: number[];
  head: number;
  message: string;
  folded: string;
}

interface SourceBucket {
  classes: OverlayClass[];
  /** Trimmed local timestamp -> class ids. Only non-empty timestamps. */
  byLocal: Map<string, number[]>;
  /** Needle = trimmed message, haystack = trimmed line text. */
  containsMessage: GramIndex | null;
  /** Needle = trimmed line text, haystack = trimmed message. */
  messageContains: GramIndex | null;
  /** Needle = folded message, haystack = folded line text. */
  containsFolded: GramIndex | null;
}

export interface HostTimestampIndex {
  readonly stamps: readonly HostEventStampV1[];
  readonly buckets: Map<string, SourceBucket>;
  readonly consumed: Uint8Array;
  /** Lowest stamp index not yet claimed; advanced lazily. */
  cursor: number;
}

interface ClassSeed {
  local: string;
  message: string;
  folded: string;
  members: number[];
}

/**
 * Build the overlay index. One pass over stamps and one cheap pass over lines
 * (to learn the shortest line needle), so the build is linear in the bytes it
 * is given.
 */
export function buildHostTimestampIndex(
  stamps: readonly HostEventStampV1[],
  lines: readonly WorkbenchLine[],
): HostTimestampIndex {
  const buckets = new Map<string, SourceBucket>();
  const index: HostTimestampIndex = {
    stamps,
    buckets,
    consumed: new Uint8Array(stamps.length),
    cursor: 0,
  };
  if (stamps.length === 0) return index;

  // Rule B searches for the *line* text inside a stamp message, so its window
  // must be no wider than the shortest line needle it will ever be asked for.
  // Taking the minimum over the corpus keeps every line answerable from the
  // index instead of falling back to a scan over stamps.
  let shortestLineNeedle: number = HOST_TIMESTAMP_OVERLAY_LIMITS.maxGramWidth;
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length < shortestLineNeedle) shortestLineNeedle = trimmed.length;
    if (shortestLineNeedle === 1) break;
  }

  const seedsByKey = new Map<string, Map<string, ClassSeed>>();
  for (let i = 0; i < stamps.length; i += 1) {
    const stamp = stamps[i];
    if (!stamp) continue;
    const key = sourceMatchKey(stamp.source);
    const local = stamp.unresolvedLocalTimestamp?.trim() ?? "";
    const message = stamp.message.trim();
    // A stamp with neither an anchorable local timestamp nor any message text
    // can never satisfy the predicate, so it is left out rather than parked in
    // an index where it would only ever be rejected. The shipped scan reaches
    // the same conclusion, one line at a time.
    if (local.length === 0 && message.length === 0) continue;
    let perSource = seedsByKey.get(key);
    if (perSource === undefined) {
      perSource = new Map();
      seedsByKey.set(key, perSource);
    }
    // Length-prefixed so the two fields cannot be confused for one another:
    // a bare separator would let ("a b", "c") and ("a", "b c") collapse into
    // one class, and an unparsable line carries its whole text as a
    // timestamp, so neither field is constrained enough to trust.
    const classKey = `${local.length}:${local}${message}`;
    const seed = perSource.get(classKey);
    if (seed === undefined) {
      perSource.set(classKey, {
        local,
        message,
        folded: message.length === 0 ? "" : foldForMatch(message),
        members: [i],
      });
    } else {
      seed.members.push(i);
    }
  }

  for (const [key, perSource] of seedsByKey) {
    const seeds = [...perSource.values()].sort(
      (left, right) => (left.members[0] ?? 0) - (right.members[0] ?? 0),
    );
    let shortestMessage: number = HOST_TIMESTAMP_OVERLAY_LIMITS.maxGramWidth;
    let shortestFolded: number = HOST_TIMESTAMP_OVERLAY_LIMITS.maxGramWidth;
    let anyMessage = false;
    for (const seed of seeds) {
      if (seed.message.length === 0) continue;
      anyMessage = true;
      if (seed.message.length < shortestMessage) shortestMessage = seed.message.length;
      if (seed.folded.length < shortestFolded) shortestFolded = seed.folded.length;
    }

    const bucket: SourceBucket = {
      classes: [],
      byLocal: new Map(),
      containsMessage: anyMessage ? createGramIndex(Math.max(shortestMessage, 1)) : null,
      messageContains: anyMessage ? createGramIndex(Math.max(shortestLineNeedle, 1)) : null,
      containsFolded: anyMessage ? createGramIndex(Math.max(shortestFolded, 1)) : null,
    };

    for (const seed of seeds) {
      const classId = bucket.classes.length;
      const stampIndex = seed.members[0] ?? 0;
      bucket.classes.push({
        members: seed.members,
        head: 0,
        message: seed.message,
        folded: seed.folded,
      });
      if (seed.local.length > 0) {
        const existing = bucket.byLocal.get(seed.local);
        if (existing === undefined) bucket.byLocal.set(seed.local, [classId]);
        else existing.push(classId);
      }
      if (seed.message.length > 0) {
        if (bucket.containsMessage !== null) {
          indexNeedlePrefix(bucket.containsMessage, seed.message, classId, stampIndex);
        }
        if (bucket.messageContains !== null) {
          indexHaystackWindows(bucket.messageContains, seed.message, classId, stampIndex);
        }
        if (bucket.containsFolded !== null) {
          indexNeedlePrefix(bucket.containsFolded, seed.folded, classId, stampIndex);
        }
      }
    }
    buckets.set(key, bucket);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Lowest stamp index this class could still claim, or `Infinity` if spent. */
function classHead(candidate: OverlayClass): number {
  return candidate.head < candidate.members.length
    ? (candidate.members[candidate.head] ?? Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
}

function lowestUnclaimed(index: HostTimestampIndex): number {
  while (index.cursor < index.consumed.length && index.consumed[index.cursor] === 1) {
    index.cursor += 1;
  }
  return index.cursor < index.consumed.length ? index.cursor : Number.POSITIVE_INFINITY;
}

/**
 * Per-line scratch. Reused across the whole overlay so a 50,000-line pass does
 * not allocate 50,000 candidate sets; `epoch` stands in for clearing it.
 */
interface Scratch {
  seen: Int32Array;
  epoch: number;
}

interface BestMatch {
  classId: number;
  stampIndex: number;
}

function scanHaystack(
  gram: GramIndex,
  haystack: string,
  bucket: SourceBucket,
  scratch: Scratch,
  verify: (candidate: OverlayClass) => boolean,
  best: BestMatch,
): void {
  const width = gram.width;
  if (haystack.length < width || gram.buckets.size === 0) return;
  // Class heads only ever move forward, so nothing in this index can beat a
  // best that is already at or below the lowest stamp it was built from.
  if (gram.minStampIndex >= best.stampIndex) return;
  let hash = hashWindow(haystack, 0, width);
  let position = 0;
  for (;;) {
    if (gram.filter[hash & FILTER_MASK] === 1) {
      const hits = gram.buckets.get(hash);
      if (hits !== undefined) {
        for (const classId of hits) {
          if (scratch.seen[classId] === scratch.epoch) continue;
          scratch.seen[classId] = scratch.epoch;
          const candidate = bucket.classes[classId];
          if (candidate === undefined) continue;
          const head = classHead(candidate);
          if (head >= best.stampIndex) continue;
          if (!verify(candidate)) continue;
          best.classId = classId;
          best.stampIndex = head;
        }
      }
    }
    position += 1;
    if (position + width > haystack.length) return;
    hash =
      (Math.imul(hash - Math.imul(gram.dropFactor, haystack.charCodeAt(position - 1)), HASH_BASE)
        + haystack.charCodeAt(position + width - 1))
      | 0;
  }
}

/**
 * Find the first unclaimed stamp that matches this line — exactly the stamp a
 * linear scan over the remaining stamps would have found — and claim it.
 *
 * Returns the stamp index, or -1 when nothing matches. The four rules are
 * consulted cheapest-first purely as an optimisation: the answer is always the
 * lowest matching stamp index across all of them, never the first rule to fire.
 */
function claimStampFor(
  index: HostTimestampIndex,
  line: WorkbenchLine,
  scratch: Scratch,
): number {
  const bucket = index.buckets.get(sourceMatchKey(line.relativePath));
  if (bucket === undefined) return -1;
  const floor = lowestUnclaimed(index);
  if (floor === Number.POSITIVE_INFINITY) return -1;
  scratch.epoch += 1;
  const best: BestMatch = { classId: -1, stampIndex: Number.POSITIVE_INFINITY };

  // Rule L — the stamp's unresolved local timestamp is this line's, verbatim.
  const original = line.originalTimestamp?.trim() ?? "";
  if (original.length > 0) {
    const hits = bucket.byLocal.get(original);
    if (hits !== undefined) {
      for (const classId of hits) {
        const candidate = bucket.classes[classId];
        if (candidate === undefined) continue;
        const head = classHead(candidate);
        if (head < best.stampIndex) {
          best.classId = classId;
          best.stampIndex = head;
        }
      }
    }
  }
  if (best.stampIndex === floor) return claim(index, bucket, best.classId);

  const text = line.text.trim();
  if (text.length > 0) {
    // Rule B — the stamp message contains the whole line. One lookup, and no
    // `seen` bookkeeping: a posting list holds each class at most once.
    const messageContains = bucket.messageContains;
    if (messageContains !== null && messageContains.minStampIndex < best.stampIndex) {
      const width = messageContains.width;
      if (text.length >= width) {
        const hash = hashWindow(text, 0, width);
        if (messageContains.filter[hash & FILTER_MASK] === 1) {
          const hits = messageContains.buckets.get(hash);
          if (hits !== undefined) {
            for (const classId of hits) {
              const candidate = bucket.classes[classId];
              if (candidate === undefined) continue;
              const head = classHead(candidate);
              if (head >= best.stampIndex) continue;
              if (!candidate.message.includes(text)) continue;
              best.classId = classId;
              best.stampIndex = head;
            }
          }
        }
      }
    }
    if (best.stampIndex === floor) return claim(index, bucket, best.classId);

    // Rule A — the line contains the stamp message. Rules A and C are distinct
    // predicates, so each gets its own epoch: a class rejected by one still
    // deserves a look from the other.
    if (bucket.containsMessage !== null) {
      scanHaystack(
        bucket.containsMessage,
        text,
        bucket,
        scratch,
        (candidate) => text.includes(candidate.message),
        best,
      );
      if (best.stampIndex === floor) return claim(index, bucket, best.classId);
    }

    // Rule C — the folded line contains the folded stamp message.
    const containsFolded = bucket.containsFolded;
    if (containsFolded !== null && containsFolded.minStampIndex < best.stampIndex) {
      const foldedText = foldForMatch(text);
      scratch.epoch += 1;
      scanHaystack(
        containsFolded,
        foldedText,
        bucket,
        scratch,
        (candidate) => foldedText.includes(candidate.folded),
        best,
      );
    }
  }
  return claim(index, bucket, best.classId);
}

function claim(index: HostTimestampIndex, bucket: SourceBucket, classId: number): number {
  if (classId < 0) return -1;
  const candidate = bucket.classes[classId];
  if (candidate === undefined) return -1;
  const stampIndex = candidate.members[candidate.head];
  if (stampIndex === undefined) return -1;
  candidate.head += 1;
  index.consumed[stampIndex] = 1;
  return stampIndex;
}

/** Largest millisecond value `Date` can represent, per ECMA-262. */
const MAX_TIME_VALUE = 8.64e15;

/**
 * Apply one claimed stamp to a line.
 *
 * A normalized UTC instant appears only for a stamp the host reports as
 * wall-clock quality. An order-only stamp, a non-finite epoch, or an epoch
 * outside the representable calendar range all leave `normalizedUtc` null:
 * "we do not know" is the honest answer, and inventing an instant — or throwing
 * and failing the whole read — would each be worse.
 */
function overlay(line: WorkbenchLine, stamp: HostEventStampV1): WorkbenchLine {
  const wall = stamp.timeQuality === "wall clock";
  let normalizedUtc: string | null = null;
  if (wall && Number.isFinite(stamp.ts)) {
    const millis = stamp.ts * 1000;
    normalizedUtc = Math.abs(millis) <= MAX_TIME_VALUE ? new Date(millis).toISOString() : null;
  }
  return {
    ...line,
    originalTimestamp: stamp.unresolvedLocalTimestamp ?? line.originalTimestamp,
    normalizedUtc,
  };
}

function scratchFor(index: HostTimestampIndex): Scratch {
  let widest = 0;
  for (const bucket of index.buckets.values()) {
    if (bucket.classes.length > widest) widest = bucket.classes.length;
  }
  return { seen: new Int32Array(widest).fill(-1), epoch: 0 };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Overlay host/cd-core timestamps onto intake lines.
 *
 * Local-ambiguous text never becomes UTC unless the host reports wall-clock
 * quality after an explicit timezone apply. Each stamp is claimed by at most
 * one line, and a line takes the first stamp — in host order — that no earlier
 * line already claimed.
 *
 * Prefer {@link applyHostTimestampsChunked} on a request path: this variant
 * runs to completion without yielding.
 */
export function applyHostTimestamps(
  lines: readonly WorkbenchLine[],
  stamps: readonly HostEventStampV1[],
): WorkbenchLine[] {
  if (stamps.length === 0) return [...lines];
  const index = buildHostTimestampIndex(stamps, lines);
  const scratch = scratchFor(index);
  const out: WorkbenchLine[] = new Array<WorkbenchLine>(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const stampIndex = claimStampFor(index, line, scratch);
    const stamp = stampIndex < 0 ? undefined : stamps[stampIndex];
    out[i] = stamp === undefined ? line : overlay(line, stamp);
  }
  return out;
}

const yieldToEventLoop: () => Promise<void> =
  typeof setImmediate === "function"
    ? () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        })
    : () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

/**
 * Cooperative overlay: identical results to {@link applyHostTimestamps}, but it
 * releases the event loop every `chunkLines` lines so an unrelated request is
 * never queued behind one investigation's corpus.
 *
 * Cancellation is all-or-nothing. An aborted overlay throws
 * {@link HostTimestampOverlayCancelledError} and returns no rows at all, so a
 * caller can never publish a corpus that is only half overlaid.
 */
export async function applyHostTimestampsChunked(
  lines: readonly WorkbenchLine[],
  stamps: readonly HostEventStampV1[],
  options: HostTimestampOverlayOptions = {},
): Promise<WorkbenchLine[]> {
  const signal = options.signal;
  const abortIfCancelled = (): void => {
    if (signal?.aborted === true) throw new HostTimestampOverlayCancelledError();
  };
  abortIfCancelled();
  if (stamps.length === 0) {
    options.onProgress?.(lines.length, lines.length);
    return [...lines];
  }
  const chunk = Math.max(
    1,
    Math.trunc(options.chunkLines ?? HOST_TIMESTAMP_OVERLAY_LIMITS.defaultChunkLines),
  );
  const step = options.yieldTo ?? yieldToEventLoop;
  const index = buildHostTimestampIndex(stamps, lines);
  const scratch = scratchFor(index);
  const out: WorkbenchLine[] = new Array<WorkbenchLine>(lines.length);
  for (let start = 0; start < lines.length; start += chunk) {
    abortIfCancelled();
    const end = Math.min(start + chunk, lines.length);
    for (let i = start; i < end; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const stampIndex = claimStampFor(index, line, scratch);
      const stamp = stampIndex < 0 ? undefined : stamps[stampIndex];
      out[i] = stamp === undefined ? line : overlay(line, stamp);
    }
    options.onProgress?.(end, lines.length);
    if (end < lines.length) await step();
  }
  abortIfCancelled();
  options.onProgress?.(lines.length, lines.length);
  return out;
}
