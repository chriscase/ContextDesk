import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, loadFixture } from "./fixtureLoader";
import { FIXTURE_PARSERS } from "./wireV1";

describe("cd.v1 contract fixtures (Rust-generated, committed)", () => {
  const manifest = Object.keys(FIXTURE_PARSERS).sort();
  const onDisk = readdirSync(FIXTURES_DIR).sort();

  it("discovery is non-empty and exactly matches the manifest", () => {
    expect(manifest.length).toBeGreaterThan(0);
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk).toEqual(manifest);
  });

  for (const [name, parse] of Object.entries(FIXTURE_PARSERS)) {
    it(`parses ${name} strictly`, () => {
      expect(() => parse(loadFixture(name))).not.toThrow();
    });
  }
});
