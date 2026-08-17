import { ESLint } from "eslint";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function lint(relPath: string) {
  const eslint = new ESLint({
    cwd: serverRoot,
    ignore: false,
  });
  const results = await eslint.lintFiles([relPath]);
  const messages = results.flatMap((r) => r.messages);
  return {
    messages,
    output: messages.map((m) => `${m.ruleId}: ${m.message}`).join("\n"),
  };
}

describe("module-boundary lint", () => {
  it("fails a cross-module deep import", async () => {
    const result = await lint("src/modules/_fixtures/cross-module-deep-import.ts");
    expect(result.output).toMatch(/no-module-deep-import|boundaries\/entry-point/);
    expect(
      result.messages.some(
        (m) =>
          m.ruleId === "local/no-module-deep-import" ||
          m.ruleId === "boundaries/entry-point",
      ),
    ).toBe(true);
  });

  it("allows importing another module only through index.ts", async () => {
    const result = await lint("src/modules/_fixtures/public-import.ts");
    expect(result.output).not.toMatch(/no-module-deep-import|boundaries\/entry-point/);
  });
});
