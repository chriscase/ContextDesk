/**
 * Versioned model-role **hint** catalog (#723).
 *
 * Pure classification of model **ids** for setup, settings, and preflight.
 * A name is evidence for a suggestion, never proof of tools, quality, context
 * length, structured output, embeddings, or reranking. Measured capability
 * (#724) and user overrides stay on separate paths.
 *
 * Keep rules aligned with `crates/cd-core/src/model_role_hints.rs`.
 */

/** Catalog / schema version (bump with the Rust module when rules change). */
export const MODEL_ROLE_HINT_CATALOG_VERSION =
  "contextdesk.model_role_hints.v1" as const;

export type ModelRoleHint =
  | "investigator"
  | "embedding"
  | "reranker"
  | "unknown";

export type HintConfidence = "high" | "medium" | "low";

/** Where a recommendation came from (UI must label the basis). */
export type HintSource =
  | "name_hint"
  | "provider_metadata"
  | "measured_locally"
  | "user_override";

export type ModelRoleSuggestion = {
  catalogVersion: string;
  role: ModelRoleHint;
  confidence: HintConfidence;
  source: HintSource;
  /** Short “Suggested for …” line. */
  suggestedFor: string;
  /** Human basis label. */
  basisLabel: string;
  /** False for embedding/reranker — do not rank as ordinary chat defaults. */
  ordinaryChatDefault: boolean;
};

const BASIS_NAME = "Name hint";

function embeddingMatch(s: string): boolean {
  return (
    s.includes("embed") ||
    s.includes("text-embedding") ||
    s.includes("nomic") ||
    s.includes("e5-") ||
    s.includes("bge-") ||
    s.includes("gte-") ||
    s.includes("voyage") ||
    s.includes("minilm") ||
    s.includes("mxbai-embed") ||
    s.includes("instructor")
  );
}

function strongEmbedding(s: string): boolean {
  return (
    s.includes("embed") ||
    s.includes("text-embedding") ||
    s.includes("bge-") ||
    s.includes("nomic-embed") ||
    s.includes("voyage")
  );
}

function rerankerMatch(s: string): boolean {
  return (
    s.includes("rerank") ||
    s.includes("re-rank") ||
    s.includes("cross-encoder") ||
    s.includes("cross_encoder") ||
    s.includes("bge-reranker")
  );
}

function strongReranker(s: string): boolean {
  return (
    s.includes("rerank") ||
    s.includes("cross-encoder") ||
    s.includes("cross_encoder")
  );
}

function investigatorMatch(s: string): boolean {
  return (
    s.includes("gpt") ||
    s.includes("claude") ||
    s.includes("mistral") ||
    s.includes("llama") ||
    s.includes("grok") ||
    s.includes("sonnet") ||
    s.includes("opus") ||
    s.includes("haiku") ||
    s.includes("gemini") ||
    s.includes("qwen") ||
    s.includes("deepseek") ||
    s.includes("phi") ||
    s.includes("command") ||
    s.includes("chat") ||
    s.includes("instruct") ||
    s.includes("o1") ||
    s.includes("o3") ||
    s.includes("o4")
  );
}

function strongInvestigator(s: string): boolean {
  return (
    s.includes("gpt-4") ||
    s.includes("gpt-5") ||
    s.includes("claude") ||
    s.includes("sonnet") ||
    s.includes("opus") ||
    s.includes("grok-3") ||
    s.includes("grok-4") ||
    s.includes("mistral") ||
    s.includes("llama-3") ||
    s.includes("gemini")
  );
}

function suggestedFor(role: ModelRoleHint): string {
  switch (role) {
    case "investigator":
      return "Suggested for: investigation chat and generation (name hint only)";
    case "embedding":
      return "Suggested for: embedding retrieval — not an ordinary chat default";
    case "reranker":
      return "Suggested for: reranking — not an ordinary chat default";
    case "unknown":
      return "Unqualified model id — remains selectable; confirm suitability before use";
  }
}

/**
 * Classify a model id into a role suggestion (pure, no I/O).
 * Specialty roles are checked before chat keywords so deceptive names stay honest.
 */
export function classifyModelRole(id: string): ModelRoleSuggestion {
  const lower = id.trim().toLowerCase();
  let role: ModelRoleHint = "unknown";
  let confidence: HintConfidence = "low";

  // Reranker before embedding (e.g. bge-reranker contains bge-).
  if (rerankerMatch(lower)) {
    role = "reranker";
    confidence = strongReranker(lower) ? "high" : "medium";
  } else if (embeddingMatch(lower)) {
    role = "embedding";
    confidence = strongEmbedding(lower) ? "high" : "medium";
  } else if (investigatorMatch(lower)) {
    role = "investigator";
    confidence = strongInvestigator(lower) ? "high" : "medium";
  }

  const ordinaryChatDefault = role === "investigator" && confidence !== "low";

  return {
    catalogVersion: MODEL_ROLE_HINT_CATALOG_VERSION,
    role,
    confidence,
    source: "name_hint",
    suggestedFor: suggestedFor(role),
    basisLabel: BASIS_NAME,
    ordinaryChatDefault,
  };
}

function chatPickerRank(id: string): number {
  const s = classifyModelRole(id);
  switch (s.role) {
    case "investigator":
      if (s.confidence === "high") return 100;
      if (s.confidence === "medium") return 80;
      return 40;
    case "unknown":
      return 30;
    case "embedding":
      return -50;
    case "reranker":
      return -60;
  }
}

/**
 * Sort model ids for a chat picker: likely investigators first; embedding and
 * reranker last. Does **not** drop any id (unknown/private stay selectable).
 *
 * Does not silently change an existing default — callers only re-order lists.
 */
export function sortIdsForChatPicker(ids: string[]): string[] {
  return [...ids].sort(
    (a, b) => chatPickerRank(b) - chatPickerRank(a) || a.localeCompare(b),
  );
}

/**
 * First id suitable as an **auto-filled** ordinary chat default, or null when
 * the inventory is specialty-only / empty. Never returns embedding/reranker.
 */
export function preferredChatDefaultId(
  ids: readonly string[],
): string | null {
  const ordered = sortIdsForChatPicker([...ids]);
  return (
    ordered.find((id) => classifyModelRole(id).ordinaryChatDefault) ?? null
  );
}

/**
 * Initial picker selection for a discover/results list:
 * - Prefer an ordinary chat-default candidate when present
 * - Otherwise use the first listed id (specialty/unknown remain selectable and
 *   confirmable via Apply — never leave the control stuck on a displayed but
 *   un-bound value)
 *
 * Does not write settings; callers still require user confirm (Apply) to persist.
 */
export function initialChatPickerSelection(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  return preferredChatDefaultId(ids) ?? ids[0] ?? "";
}

/**
 * Filter out ids the user has hidden (#678). Classification itself never
 * expands hidden inventory; this only drops known-hidden ids from a list
 * the host already returned for ordinary pickers.
 */
export function excludeHiddenModelIds(
  ids: string[],
  hiddenIds: ReadonlySet<string> | readonly string[] | undefined | null,
): string[] {
  if (!hiddenIds) return [...ids];
  const set =
    hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds);
  if (set.size === 0) return [...ids];
  return ids.filter((id) => !set.has(id));
}

/** Accessible one-line summary for a suggestion (role + basis). */
export function formatRoleHintAccessible(s: ModelRoleSuggestion): string {
  return `${s.suggestedFor}. Basis: ${s.basisLabel} (${s.confidence} confidence). Not measured capability.`;
}

/**
 * Merge recommendation basis labels for UI that may later combine sources.
 * Name hints never claim to be measured or user overrides.
 */
export function describeRecommendationBasis(
  sources: HintSource[],
): string {
  const labels: string[] = [];
  for (const src of sources) {
    switch (src) {
      case "name_hint":
        labels.push("Name hint");
        break;
      case "provider_metadata":
        labels.push("Provider metadata");
        break;
      case "measured_locally":
        labels.push("Measured locally");
        break;
      case "user_override":
        labels.push("User override");
        break;
    }
  }
  return labels.length ? labels.join(" · ") : "Name hint";
}
