import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const deployDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy");

const forbiddenHost = /(acme|corp\.internal|intranet|\.lan\b)/i;
const forbiddenSecret = /(sk-|api[_-]?key\s*=\s*[^r]|password=\s*[^r])/i;

describe("example deployment config", () => {
  const files = [
    "docker-compose.example.yml",
    ".env.example",
    "init-db.sql",
    "README.md",
  ];

  it("contains no secrets or company-specific hostnames", () => {
    for (const name of files) {
      const body = readFileSync(join(deployDir, name), "utf8");
      expect(body, name).not.toMatch(forbiddenHost);
      expect(body, name).not.toMatch(forbiddenSecret);
      expect(body, name).toMatch(/secret-store|replace-from-secret-store|secret store/i);
    }
  });
});
