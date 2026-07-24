import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const components = dirname(fileURLToPath(import.meta.url));
const src = join(components, "..");

function source(path: string): string {
  return readFileSync(join(src, path), "utf8");
}

describe("Help discovery production wiring (#440)", () => {
  it("ships both command-palette actions into the Help pane", () => {
    const app = source("App.tsx");
    expect(app).toContain('id: "action:open-help"');
    expect(app).toContain('id: "action:search-help"');
    expect(app).toContain('openHelp({ pageId: "product-overview" })');
    expect(app).toContain("openHelp({ focusSearch: true })");
  });

  it("deep-links three contextual surfaces to checked-in page ids", () => {
    const logs = source("components/panes/LogPane.tsx");
    const memory = source("components/panes/MemoryPane.tsx");
    const settings = source("components/SettingsModal.tsx");
    const help = source("lib/help.ts");
    expect(logs).toContain('onOpenHelp("log-analysis-pipeline")');
    expect(memory).toContain('onOpenHelp("memory-overview")');
    expect(settings).toContain("helpPageForSettingsSection");
    expect(help).toContain('return "first-run"');
  });

  it("enables Learn more in both shipped session wizards", () => {
    const app = source("App.tsx");
    const registry = source("components/wizards/registry.ts");
    expect(app.match(/helpAvailable/g)).toHaveLength(2);
    expect(registry).toContain('helpPageId: "log-analysis-pipeline"');
    expect(registry).not.toContain('"logs-pipeline"');
  });
});
