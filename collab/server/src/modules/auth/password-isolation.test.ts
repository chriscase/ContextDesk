import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith(".ts") || full.endsWith(".mjs")) acc.push(full);
  }
  return acc;
}

describe("password isolation", () => {
  it("no module outside auth imports ldapts or reads a password field", () => {
    const files = walk(serverSrc).filter((f) => {
      const rel = relative(serverSrc, f).split("/").join("/");
      if (rel.startsWith("modules/auth/")) return false;
      if (rel.startsWith("modules/_fixtures/")) return false;
      if (rel.endsWith(".test.ts")) return false;
      return true;
    });
    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, "utf8");
      const rel = relative(serverSrc, file);
      if (body.includes("from \"ldapts\"") || body.includes("from 'ldapts'")) {
        offenders.push(`${rel}: ldapts import`);
      }
      if (/\.password\b/.test(body) || /body\.password/.test(body)) {
        offenders.push(`${rel}: password field access`);
      }
      if (body.includes("COLLAB_LDAP_BIND_PASSWORD")) {
        offenders.push(`${rel}: service-bind password`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
