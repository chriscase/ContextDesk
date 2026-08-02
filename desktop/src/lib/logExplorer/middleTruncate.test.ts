import { describe, expect, it } from "vitest";
import { middleTruncate, splitGraphemes } from "./middleTruncate";

/** True when every UTF-16 surrogate in `text` is a correctly ordered pair. */
function hasNoLoneSurrogates(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Every grapheme of `result` (ellipsis aside) is a whole input grapheme. */
function graphemesComeFromInput(result: string, input: string): boolean {
  const inputSet = new Set(splitGraphemes(input));
  return splitGraphemes(result).every(
    (grapheme) => grapheme === "…" || inputSet.has(grapheme),
  );
}

describe("middleTruncate", () => {
  it("returns short names unchanged, including at the exact limit", () => {
    expect(middleTruncate("checkout", 30)).toBe("checkout");
    expect(middleTruncate("a".repeat(30), 30)).toBe("a".repeat(30));
    expect(middleTruncate("", 10)).toBe("");
  });

  it("splits 60/40 around a single U+2026 with head/tail floors", () => {
    const name = "abcdefghijklmnopqrstuvwxyz0123456789";
    // limit 15 → budget 14 → head 8, tail 6 (head floor engages after clamp).
    expect(middleTruncate(name, 15)).toBe("abcdefgh…456789");
    // limit 21 → budget 20 → head 12, tail 8.
    expect(middleTruncate(name, 21)).toBe("abcdefghijkl…23456789");
    const out = middleTruncate(name, 21);
    expect(out.split("…")).toHaveLength(2);
    expect(splitGraphemes(out)).toHaveLength(21);
  });

  it("end-truncates below the 15-grapheme middle budget", () => {
    const name = "abcdefghijklmnopqrstuvwxyz";
    expect(middleTruncate(name, 14)).toBe("abcdefghijkl…"); // min(12, 13) = 12
    expect(middleTruncate(name, 10)).toBe("abcdefghi…"); // limit-1 = 9
    expect(middleTruncate(name, 2)).toBe("a…");
    expect(middleTruncate(name, 0)).toBe("…");
  });

  it("keeps the distinct tails of two names differing only at the tail", () => {
    const base = "checkout-cascade-full-fidelity-replay-eu-central-refunds-";
    const revA = middleTruncate(`${base}rev-A`, 24);
    const revB = middleTruncate(`${base}rev-B`, 24);
    expect(revA).not.toBe(revB);
    expect(revA.endsWith("rev-A")).toBe(true);
    expect(revB.endsWith("rev-B")).toBe(true);
    expect(revA).toContain("…");
  });

  it("never splits emoji ZWJ family sequences", () => {
    const family = "👨‍👩‍👧‍👦";
    const name = family.repeat(24);
    const out = middleTruncate(name, 17);
    expect(out).toContain("…");
    expect(hasNoLoneSurrogates(out)).toBe(true);
    expect(graphemesComeFromInput(out, name)).toBe(true);
    // Both sides re-assemble into whole families only.
    const [head, tail] = out.split("…") as [string, string];
    expect(head.length % family.length).toBe(0);
    expect(tail.length % family.length).toBe(0);
    expect(splitGraphemes(out)).toHaveLength(17);
  });

  it("never separates combining diacritics from their base", () => {
    const cluster = "é"; // é as base + combining acute
    const name = cluster.repeat(40);
    const out = middleTruncate(name, 19);
    expect(out).toContain("…");
    for (const grapheme of splitGraphemes(out)) {
      if (grapheme === "…") continue;
      expect(grapheme).toBe(cluster);
    }
    expect(out).not.toMatch(/^́/);
    expect(out.split("…")[1]!.startsWith("́")).toBe(false);
  });

  it("handles Arabic RTL text by grapheme, not by code unit", () => {
    const name = "سجل-الأحداث-الكامل-للإصدار-التجريبي-الثاني-عشر-مراجعة-نهائية";
    const out = middleTruncate(name, 25);
    expect(out).toContain("…");
    expect(splitGraphemes(out)).toHaveLength(25);
    expect(hasNoLoneSurrogates(out)).toBe(true);
    expect(graphemesComeFromInput(out, name)).toBe(true);
  });

  it("handles CJK names by grapheme count", () => {
    const name = "訂單級聯故障重現語料庫二零二六年七月三十一日完整保真版本";
    const out = middleTruncate(name, 17);
    expect(splitGraphemes(out)).toHaveLength(17);
    expect(out).toContain("…");
    expect(out.startsWith("訂單級聯故障重現")).toBe(true);
    expect(out.endsWith("完整保真版本")).toBe(true); // tail keeps 6 graphemes
    expect(out.endsWith("日完整保真版本")).toBe(false); // …not 7
    expect(graphemesComeFromInput(out, name)).toBe(true);
  });

  it("tolerates non-finite and fractional limits defensively", () => {
    expect(middleTruncate("abc", Number.NaN)).toBe("abc");
    expect(middleTruncate("abcdefghijklmnopqrst", 15.9)).toBe(
      middleTruncate("abcdefghijklmnopqrst", 15),
    );
  });
});
