/**
 * Concise “Suggested for …” line for model pickers (#723).
 * Name hints only — never auto-applies a default or role binding.
 */
import {
  classifyModelRole,
  formatRoleHintAccessible,
  recommendationBasisLabel,
  type ModelRoleSuggestion,
} from "../../lib/modelRoleHints";

export type ModelRoleHintLineProps = {
  modelId: string | null | undefined;
  /** Optional precomputed suggestion (avoids double classify). */
  suggestion?: ModelRoleSuggestion;
  className?: string;
  id?: string;
};

export function ModelRoleHintLine({
  modelId,
  suggestion,
  className = "field__hint model-role-hint",
  id,
}: ModelRoleHintLineProps) {
  const raw = modelId?.trim() ?? "";
  if (!raw) return null;
  const s = suggestion ?? classifyModelRole(raw);
  const basis = recommendationBasisLabel(s.source);
  const a11y = formatRoleHintAccessible(s);
  return (
    <p
      id={id}
      className={className}
      role="note"
      data-testid="model-role-hint"
      data-role={s.role}
      data-source={s.source}
      data-confidence={s.confidence}
      aria-label={a11y}
    >
      <span className="model-role-hint__suggested">{s.suggestedFor}</span>
      <span className="model-role-hint__basis">
        {" "}
        · Basis: {basis} · Confidence: {s.confidence}
      </span>
    </p>
  );
}
