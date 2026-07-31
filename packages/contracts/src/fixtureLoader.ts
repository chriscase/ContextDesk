/** Test helper: locate and load the committed Rust-generated fixtures. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `fixtures/contracts/` at the repo root. */
export const FIXTURES_DIR = join(
  here,
  "..",
  "..",
  "..",
  "fixtures",
  "contracts",
);

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}
