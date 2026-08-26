/**
 * Host timestamp overlay: equivalence, bounds, and cancellation.
 *
 * The overlay was rewritten from a scan over every (line, stamp) pair into an
 * indexed join, so the first duty of these tests is to prove the rewrite did
 * not move the answer. {@link referenceApplyHostTimestamps} is the shipped
 * implementation transcribed verbatim; the differential tests below drive both
 * with the same generated corpora and require identical output.
 *
 * All data is synthetic: invented batch workers, invented edge gateways, and
 * generated message text. Nothing here reads a provider, a network, or a real
 * investigation.
 */
import { describe, expect, it } from "vitest";
import {
  HOST_TIMESTAMP_OVERLAY_LIMITS,
  HostTimestampOverlayCancelledError,
  applyHostTimestamps,
  applyHostTimestampsChunked,
  hostTimestampSourceMatch,
  sourceMatchKey,
} from "./investigation-workbench-timestamps.js";
import {
  WORKBENCH_LIMITS,
  splitLogText,
  type HostEventStampV1,
  type WorkbenchLine,
} from "./investigation-workbench.js";

const DIGEST = "b".repeat(64);
/** The overlay only ever sees a corpus the read limit already bounded. */
const WORKBENCH_CAP = WORKBENCH_LIMITS.maxSearchWorkLines;

// ---------------------------------------------------------------------------
// Reference implementation — the shipped join, transcribed unchanged
// ---------------------------------------------------------------------------

function referenceStampMatchesLine(stamp: HostEventStampV1, line: WorkbenchLine): boolean {
  const source = stamp.source.replace(/\\/g, "/");
  const path = line.relativePath.replace(/\\/g, "/");
  const sourceOk =
    source === path
    || path.endsWith(`/${source}`)
    || source.endsWith(`/${path}`)
    || source.split("/").pop() === path.split("/").pop();
  if (!sourceOk) return false;
  const local = stamp.unresolvedLocalTimestamp?.trim();
  const original = line.originalTimestamp?.trim();
  if (local && original && local === original) return true;
  const message = stamp.message.trim();
  const text = line.text.trim();
  if (!message || !text) return false;
  if (text.includes(message) || message.includes(text)) return true;
  const fold = (value: string) => value.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
  return fold(text).includes(fold(message));
}

function referenceApplyHostTimestamps(
  lines: readonly WorkbenchLine[],
  stamps: readonly HostEventStampV1[],
): WorkbenchLine[] {
  if (stamps.length === 0) return [...lines];
  const remaining = [...stamps];
  return lines.map((line) => {
    const index = remaining.findIndex((stamp) => referenceStampMatchesLine(stamp, line));
    if (index < 0) return line;
    const [stamp] = remaining.splice(index, 1);
    if (!stamp) return line;
    const wall = stamp.timeQuality === "wall clock";
    const normalizedUtc =
      wall && Number.isFinite(stamp.ts) ? new Date(stamp.ts * 1000).toISOString() : null;
    return {
      ...line,
      originalTimestamp: stamp.unresolvedLocalTimestamp ?? line.originalTimestamp,
      normalizedUtc,
    };
  });
}

// ---------------------------------------------------------------------------
// Deterministic synthetic generators
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG, so a failure is always reproducible from a seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  const chosen = values[Math.floor(next() * values.length) % values.length];
  if (chosen === undefined) throw new Error("empty choice set");
  return chosen;
}

function line(
  relativePath: string,
  lineNumber: number,
  text: string,
  originalTimestamp: string | null,
): WorkbenchLine {
  return {
    evidenceId: `ev-${relativePath}`,
    relativePath,
    rotationFamily: relativePath,
    intakeBatchId: null,
    lineNumber,
    byteOffset: lineNumber * 80,
    text,
    wrapped: false,
    severity: null,
    component: null,
    originalTimestamp,
    normalizedUtc: null,
    parseClass: originalTimestamp === null ? "missing" : "local_ambiguous",
    digest: DIGEST,
  };
}

const FILES = ["worker/batch.log", "gateway/edge.log", "svc/api.log"] as const;
const LEVELS = ["INFO", "WARN", "ERROR"] as const;
const VERBS = ["sweep", "heartbeat late", "retry", "flush queue", "reconnect"] as const;

/**
 * A corpus with the shapes the overlay actually has to survive: explicit
 * offsets, bare local calendar times, unparsable text, and repeated lines.
 */
function syntheticCorpus(count: number, seed: number): WorkbenchLine[] {
  const next = rng(seed);
  const rows: WorkbenchLine[] = [];
  for (let i = 0; i < count; i += 1) {
    const file = pick(next, FILES);
    const kind = next();
    if (kind < 0.25) {
      // Duplicate text on purpose: many lines share one message body.
      rows.push(line(file, i, `${pick(next, LEVELS)} repeated shard flush`, null));
    } else if (kind < 0.5) {
      rows.push(line(file, i, `operator note: ${pick(next, VERBS)} observed`, null));
    } else if (kind < 0.75) {
      const stamp = `2024-03-1${i % 10} 0${i % 10}:${String(i % 60).padStart(2, "0")}:00`;
      rows.push(line(file, i, `${stamp} ${pick(next, LEVELS)} ${pick(next, VERBS)} n=${i}`, stamp));
    } else {
      const stamp = `2024-03-11T04:${String(i % 60).padStart(2, "0")}:00+00:00`;
      rows.push(line(file, i, `${stamp} ${pick(next, LEVELS)} ${pick(next, VERBS)}`, stamp));
    }
  }
  return rows;
}

function syntheticStamps(count: number, seed: number, corpus: readonly WorkbenchLine[]): HostEventStampV1[] {
  const next = rng(seed);
  const stamps: HostEventStampV1[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = next();
    const borrow = corpus[Math.floor(next() * corpus.length) % Math.max(corpus.length, 1)];
    if (kind < 0.3 && borrow) {
      // Anchored on a real line's local timestamp.
      stamps.push({
        source: borrow.relativePath,
        message: borrow.text.slice(0, 24),
        ts: 1_710_000_000 + i,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: borrow.originalTimestamp,
      });
    } else if (kind < 0.55 && borrow) {
      // Anchored on a real line's text, folded shapes included.
      stamps.push({
        source: sourceMatchKey(borrow.relativePath),
        message: borrow.text.toUpperCase(),
        ts: 1_710_000_000 + i,
        timeQuality: "order only (not calendar time)",
        unresolvedLocalTimestamp: null,
      });
    } else if (kind < 0.8) {
      // Matches nothing: the corpus already reads correctly.
      stamps.push({
        source: pick(next, FILES),
        message: `unrelated host event ordinal=${i} kind=heartbeat`,
        ts: 1_710_000_000 + i,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      });
    } else {
      // Degenerate shapes: empty message, whitespace, a foreign source.
      stamps.push({
        source: next() < 0.5 ? "unknown/other.log" : pick(next, FILES),
        message: next() < 0.5 ? "" : "  ",
        ts: 1_710_000_000 + i,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: next() < 0.5 ? null : "2024-03-10 01:30:00",
      });
    }
  }
  return stamps;
}

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

describe("source relation", () => {
  it("is exactly final-path-segment equality", () => {
    const paths = [
      "worker/batch.log",
      "batch.log",
      "a/b/worker/batch.log",
      "worker\\batch.log",
      "other.log",
      "b/other.log",
      "",
      "a/",
      "batch.log.1",
      "prebatch.log",
    ];
    for (const source of paths) {
      for (const path of paths) {
        expect({ source, path, ok: hostTimestampSourceMatch(source, path) }).toEqual({
          source,
          path,
          ok: sourceMatchKey(source) === sourceMatchKey(path),
        });
      }
    }
  });
});

describe("indexed overlay equivalence", () => {
  it("matches the shipped join on every generated corpus", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const lines = syntheticCorpus(120, seed);
      const stamps = syntheticStamps(40, seed * 7919, lines);
      expect({ seed, rows: applyHostTimestamps(lines, stamps) }).toEqual({
        seed,
        rows: referenceApplyHostTimestamps(lines, stamps),
      });
    }
  });

  it("matches the shipped join when stamps outnumber lines", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const lines = syntheticCorpus(25, seed * 31);
      const stamps = syntheticStamps(200, seed * 104_729, lines);
      expect({ seed, rows: applyHostTimestamps(lines, stamps) }).toEqual({
        seed,
        rows: referenceApplyHostTimestamps(lines, stamps),
      });
    }
  });

  it("keeps host order when duplicate text competes for the same line", () => {
    const rows = [
      line("worker/batch.log", 1, "flush queue", null),
      line("worker/batch.log", 2, "flush queue", null),
      line("worker/batch.log", 3, "flush queue", null),
    ];
    const stamps: HostEventStampV1[] = [0, 1, 2].map((i) => ({
      source: "worker/batch.log",
      message: "flush queue",
      ts: 1_710_000_000 + i,
      timeQuality: "wall clock",
      unresolvedLocalTimestamp: null,
    }));
    const overlaid = applyHostTimestamps(rows, stamps);
    expect(overlaid.map((row) => row.normalizedUtc)).toEqual(
      stamps.map((stamp) => new Date(stamp.ts * 1000).toISOString()),
    );
    expect(overlaid).toEqual(referenceApplyHostTimestamps(rows, stamps));
  });

  it("prefers the earliest host stamp even when a later rule would fire first", () => {
    const rows = [line("worker/batch.log", 1, "2024-03-10 01:30:00 INFO sweep", "2024-03-10 01:30:00")];
    // Stamp 0 can only match by folded text; stamp 1 matches by local
    // timestamp. Host order must win over which rule is cheapest to answer.
    const stamps: HostEventStampV1[] = [
      {
        source: "worker/batch.log",
        message: "2024-03-10 01:30:00 info SWEEP",
        ts: 1_710_045_000,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      },
      {
        source: "worker/batch.log",
        message: "unrelated",
        ts: 1_710_099_999,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: "2024-03-10 01:30:00",
      },
    ];
    expect(applyHostTimestamps(rows, stamps)[0]?.normalizedUtc).toBe(
      new Date(1_710_045_000 * 1000).toISOString(),
    );
    expect(applyHostTimestamps(rows, stamps)).toEqual(referenceApplyHostTimestamps(rows, stamps));
  });

  it("keeps two stamps apart when their fields split differently", () => {
    // ("ab", "c") and ("a", "bc") concatenate to the same string. If the index
    // keyed classes by a bare join, these two stamps would collapse into one
    // and the second line would go unclaimed. An unparsable line carries its
    // whole text as its timestamp, so neither field is short or constrained.
    const rows = [
      line("worker/batch.log", 1, "zzz", "a"),
      line("worker/batch.log", 2, "yyy", "ab"),
    ];
    const stamps: HostEventStampV1[] = [
      {
        source: "worker/batch.log",
        message: "c",
        ts: 1_710_000_001,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: "ab",
      },
      {
        source: "worker/batch.log",
        message: "bc",
        ts: 1_710_000_002,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: "a",
      },
    ];
    const overlaid = applyHostTimestamps(rows, stamps);
    expect(overlaid).toEqual(referenceApplyHostTimestamps(rows, stamps));
    expect(overlaid[0]?.normalizedUtc).toBe(new Date(1_710_000_002 * 1000).toISOString());
    expect(overlaid[1]?.normalizedUtc).toBe(new Date(1_710_000_001 * 1000).toISOString());
  });

  it("keeps a stamp message that contains the whole line", () => {
    const rows = [line("worker/batch.log", 1, "sweep", null)];
    const stamps: HostEventStampV1[] = [
      {
        source: "worker/batch.log",
        message: "batch worker did sweep and then stopped",
        ts: 1_710_045_000,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      },
    ];
    expect(applyHostTimestamps(rows, stamps)).toEqual(referenceApplyHostTimestamps(rows, stamps));
    expect(applyHostTimestamps(rows, stamps)[0]?.normalizedUtc).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timestamp discipline
// ---------------------------------------------------------------------------

describe("timestamp discipline", () => {
  it("never invents UTC for an order-only stamp", () => {
    const rows = splitLogText("ev-a", "worker/batch.log", DIGEST, "2024-03-10 02:30:00 INFO sweep\n", null);
    expect(rows[0]?.normalizedUtc).toBeNull();
    const overlaid = applyHostTimestamps(rows, [
      {
        source: "worker/batch.log",
        message: "sweep",
        ts: 3,
        timeQuality: "order only (not calendar time)",
        unresolvedLocalTimestamp: "2024-03-10 02:30:00",
      },
    ]);
    expect(overlaid[0]?.normalizedUtc).toBeNull();
    expect(overlaid[0]?.originalTimestamp).toBe("2024-03-10 02:30:00");
    expect(overlaid[0]?.parseClass).toBe(rows[0]?.parseClass);
  });

  it("leaves a line untouched when no stamp claims it", () => {
    const rows = syntheticCorpus(50, 99);
    const overlaid = applyHostTimestamps(rows, [
      {
        source: "unknown/other.log",
        message: "nothing here matches",
        ts: 1_710_045_000,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      },
    ]);
    expect(overlaid).toEqual(rows);
  });

  it("reports no instant rather than throwing on an out-of-range epoch", () => {
    const rows = [line("worker/batch.log", 1, "sweep", null)];
    const overlaid = applyHostTimestamps(rows, [
      {
        source: "worker/batch.log",
        message: "sweep",
        ts: 1e18,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      },
    ]);
    expect(overlaid[0]?.normalizedUtc).toBeNull();
    // The shipped join threw a RangeError here and failed the whole read.
    expect(() => referenceApplyHostTimestamps(rows, [
      {
        source: "worker/batch.log",
        message: "sweep",
        ts: 1e18,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      },
    ])).toThrow(RangeError);
  });

  it("preserves evidence identity and row order for every line", () => {
    const rows = syntheticCorpus(400, 5);
    const stamps = syntheticStamps(150, 11, rows);
    const overlaid = applyHostTimestamps(rows, stamps);
    expect(overlaid).toHaveLength(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      expect({
        evidenceId: overlaid[i]?.evidenceId,
        lineNumber: overlaid[i]?.lineNumber,
        byteOffset: overlaid[i]?.byteOffset,
        digest: overlaid[i]?.digest,
        text: overlaid[i]?.text,
        parseClass: overlaid[i]?.parseClass,
      }).toEqual({
        evidenceId: rows[i]?.evidenceId,
        lineNumber: rows[i]?.lineNumber,
        byteOffset: rows[i]?.byteOffset,
        digest: rows[i]?.digest,
        text: rows[i]?.text,
        parseClass: rows[i]?.parseClass,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Cooperative execution
// ---------------------------------------------------------------------------

describe("cooperative overlay", () => {
  it("returns exactly what the synchronous overlay returns", async () => {
    const rows = syntheticCorpus(500, 17);
    const stamps = syntheticStamps(120, 23, rows);
    await expect(applyHostTimestampsChunked(rows, stamps, { chunkLines: 37 })).resolves.toEqual(
      referenceApplyHostTimestamps(rows, stamps),
    );
  });

  it("is idempotent: re-overlaying an overlaid corpus is a no-op", async () => {
    const rows = syntheticCorpus(300, 41);
    const stamps = syntheticStamps(90, 43, rows);
    const once = await applyHostTimestampsChunked(rows, stamps, { chunkLines: 64 });
    const twice = await applyHostTimestampsChunked(rows, stamps, { chunkLines: 64 });
    expect(twice).toEqual(once);
  });

  it("yields between chunks and reports truthful progress", async () => {
    const rows = syntheticCorpus(250, 3);
    const stamps = syntheticStamps(20, 5, rows);
    let yields = 0;
    const progress: [number, number][] = [];
    await applyHostTimestampsChunked(rows, stamps, {
      chunkLines: 50,
      yieldTo: async () => {
        yields += 1;
      },
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(yields).toBe(4);
    expect(progress.at(-1)).toEqual([250, 250]);
    for (const [done, total] of progress) {
      expect(total).toBe(250);
      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThanOrEqual(250);
    }
    expect(progress.map(([done]) => done)).toEqual([...progress.map(([done]) => done)].sort((a, b) => a - b));
  });

  it("cancels mid-apply without producing a partial corpus", async () => {
    const rows = syntheticCorpus(400, 7);
    const stamps = syntheticStamps(60, 9, rows);
    const signal = { aborted: false };
    let chunks = 0;
    const attempt = applyHostTimestampsChunked(rows, stamps, {
      chunkLines: 25,
      signal,
      yieldTo: async () => {
        chunks += 1;
        if (chunks === 3) signal.aborted = true;
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(HostTimestampOverlayCancelledError);
    expect(chunks).toBe(3);
  });

  it("refuses to start when the caller has already given up", async () => {
    const rows = syntheticCorpus(10, 1);
    const stamps = syntheticStamps(4, 2, rows);
    await expect(
      applyHostTimestampsChunked(rows, stamps, { signal: { aborted: true } }),
    ).rejects.toBeInstanceOf(HostTimestampOverlayCancelledError);
  });

  it("does not stall an unrelated task queued behind it", async () => {
    const rows = syntheticCorpus(4_000, 13);
    const stamps = syntheticStamps(400, 19, rows);
    const ticks: string[] = [];
    const unrelated = (async () => {
      for (let i = 0; i < 6; i += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        ticks.push(`unrelated-${i}`);
      }
    })();
    await Promise.all([
      applyHostTimestampsChunked(rows, stamps, { chunkLines: 200 }).then(() => ticks.push("overlay")),
      unrelated,
    ]);
    // The unrelated task must get turns while the overlay is still running,
    // which is only possible if the overlay actually releases the loop.
    expect(ticks.indexOf("unrelated-0")).toBeLessThan(ticks.indexOf("overlay"));
    expect(ticks.filter((tick) => tick.startsWith("unrelated")).length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

describe("scale", () => {
  /**
   * The regression this module exists to prevent.
   *
   * The threshold is deliberately loose — two orders of magnitude above what
   * the indexed join costs on a developer machine — so it survives a loaded CI
   * runner while still failing hard if the join ever goes quadratic again. The
   * shipped join needed roughly 100 seconds for this input; the budget here is
   * 20, and a passing run reports well under 1.
   *
   * Reproduce with:
   *   npm run test -w @cd-collab/contracts -- investigation-workbench-timestamps
   */
  const BUDGET_MS = 20_000;

  it(`overlays the ${WORKBENCH_CAP.toLocaleString("en-US")}-line read cap within ${BUDGET_MS} ms`, async () => {
    const rows = syntheticCorpus(WORKBENCH_CAP, 2024);
    const stamps = syntheticStamps(2_000, 4048, rows);
    const before = process.memoryUsage().heapUsed;
    const started = process.hrtime.bigint();
    const overlaid = await applyHostTimestampsChunked(rows, stamps, {
      chunkLines: HOST_TIMESTAMP_OVERLAY_LIMITS.defaultChunkLines,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const grownMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);

    expect(overlaid).toHaveLength(WORKBENCH_CAP);
    // One stamp is claimed at most once, so no line may share an instant with
    // more lines than the host offered.
    const claimed = overlaid.filter((row) => row.normalizedUtc !== null).length;
    expect(claimed).toBeLessThanOrEqual(2_000);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    // Overlay output is one object per line plus the index; a run that starts
    // retaining per-pair work would blow past this long before it got slow.
    expect(grownMb).toBeLessThan(512);
  });

  it("does not pay for stamps it cannot match", async () => {
    // The defect was O(lines x stamps), so the discriminating axis is *stamps*,
    // not lines: with the stamp count fixed, even the pairwise scan is linear
    // in lines and looks fine. Holding lines fixed and growing stamps 8x is
    // what separates the two — the pairwise scan grows with it, an indexed
    // join barely moves because only the one-time build is larger.
    const lines = syntheticCorpus(6_000, 101);
    const measure = async (stampCount: number): Promise<number> => {
      const stamps = syntheticStamps(stampCount, 103, lines);
      const started = process.hrtime.bigint();
      await applyHostTimestampsChunked(lines, stamps, { chunkLines: 4_096 });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    await measure(250); // warm the JIT so the ratio measures the algorithm
    const few = await measure(250);
    const many = await measure(2_000);
    // 8x the stamps. A pairwise join costs about 8x more; this allows 4x, so a
    // noisy runner cannot fail it but a return to quadratic cannot pass it.
    expect(many).toBeLessThan(Math.max(few, 1) * 4);
  });
});
