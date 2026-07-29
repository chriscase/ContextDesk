/**
 * Model role hint line UI (#723) — real component, synthetic model ids only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SKINS } from "../../lib/skins";
import type {
  HintSource,
  ModelRoleSuggestion,
} from "../../lib/modelRoleHints";
import { ModelRoleHintLine } from "./ModelRoleHintLine";

const here = dirname(fileURLToPath(import.meta.url));

function suggestion(
  source: HintSource,
  confidence: ModelRoleSuggestion["confidence"] = "low",
): ModelRoleSuggestion {
  return {
    catalogVersion: "adversarial.precomputed",
    role: "unknown",
    confidence,
    source,
    suggestedFor: "Unqualified model id — remains selectable",
    // Deliberately inconsistent: the component must derive visible basis from source.
    basisLabel: "WRONG: measured locally",
    ordinaryChatDefault: false,
  };
}

describe("ModelRoleHintLine", () => {
  it("renders Suggested for embedding with name-hint basis and a11y label", () => {
    render(<ModelRoleHintLine modelId="bge-m3" id="hint-1" />);
    const el = screen.getByTestId("model-role-hint");
    expect(el.getAttribute("data-role")).toBe("embedding");
    expect(el.getAttribute("data-source")).toBe("name_hint");
    expect(el.textContent).toMatch(/Suggested for: embedding/);
    expect(el.textContent).toMatch(/Basis: Name hint/);
    expect(el.getAttribute("aria-label")).toMatch(/Not measured capability/);
  });

  it("renders unqualified copy for private aliases", () => {
    render(<ModelRoleHintLine modelId="corp-private-alias" />);
    const el = screen.getByTestId("model-role-hint");
    expect(el.getAttribute("data-role")).toBe("unknown");
    expect(el.textContent).toMatch(/Unqualified/);
  });

  it("renders nothing for empty model id", () => {
    const { container } = render(<ModelRoleHintLine modelId="  " />);
    expect(container.querySelector("[data-testid=model-role-hint]")).toBeNull();
  });

  it("marks investigator suggestions for chat-like ids", () => {
    render(<ModelRoleHintLine modelId="grok-3" />);
    const el = screen.getByTestId("model-role-hint");
    expect(el.getAttribute("data-role")).toBe("investigator");
    expect(el.textContent).toMatch(/investigation chat/);
  });

  it.each([
    ["name_hint", "Name hint"],
    ["provider_metadata", "Provider metadata"],
    ["measured_locally", "Measured locally"],
    ["user_override", "User override"],
  ] as const)(
    "derives the visible %s basis from typed source and always shows confidence",
    (source, expectedBasis) => {
      render(
        <ModelRoleHintLine
          modelId="private-deployment"
          suggestion={suggestion(source)}
        />,
      );
      const el = screen.getByTestId("model-role-hint");
      expect(el.textContent).toContain(`Basis: ${expectedBasis}`);
      expect(el.textContent).toContain("Confidence: low");
      expect(el.textContent).not.toContain("WRONG");
      expect(el.getAttribute("aria-label")).toContain(
        `Basis: ${expectedBasis} (low confidence)`,
      );
    },
  );

  it("renders the semantic role treatment under every shipped theme", () => {
    const componentCss = readFileSync(
      join(here, "../../styles/components/forms.css"),
      "utf8",
    );
    expect(componentCss).toMatch(
      /\.model-role-hint__suggested[\s\S]*var\(--text-muted/,
    );
    expect(componentCss).toMatch(
      /\.model-role-hint__basis[\s\S]*var\(--text-faint/,
    );
    expect(componentCss).toMatch(
      /\.model-role-hint\[data-role="embedding"\][\s\S]*var\(--warning/,
    );

    for (const skin of SKINS) {
      const themeCss = readFileSync(
        join(here, "../../styles/themes", `${skin.id}.css`),
        "utf8",
      );
      for (const token of ["text-muted", "text-faint", "warning"]) {
        expect(themeCss, `${skin.id} --${token}`).toMatch(
          new RegExp(`--${token}\\s*:`),
        );
      }
      document.documentElement.dataset.theme = skin.id;
      const view = render(<ModelRoleHintLine modelId="bge-m3" />);
      const el = screen.getByTestId("model-role-hint");
      expect(document.documentElement.dataset.theme).toBe(skin.id);
      expect(el.classList.contains("model-role-hint")).toBe(true);
      expect(el.getAttribute("data-role")).toBe("embedding");
      expect(el.getAttribute("style")).toBeNull();
      expect(el.textContent).toContain("Confidence: high");
      view.unmount();
    }
    delete document.documentElement.dataset.theme;
  });
});
