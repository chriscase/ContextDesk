/**
 * Presentation metadata per `ActivityOrigin`.
 *
 * Requirement 4: a reader must be able to tell deterministic host work from
 * model/external work **without relying on colour**. Every badge therefore
 * pairs a text label with a glyph, and the `work` field gives the coarse
 * deterministic-vs-nondeterministic split in words. Colour, where the
 * stylesheet uses it, is a third redundant signal only.
 */
import {
  determinismForOrigin,
  isNondeterministicOrigin,
  type ActivityOrigin,
  type Determinism,
} from "./types";

/** The coarse split requirement 4 asks the UI to make obvious. */
export type ActivityWorkClass = "deterministic" | "nondeterministic";

export type OriginMeta = {
  /** Primary signal. Always rendered as text. */
  label: string;
  /** Secondary signal. Always rendered alongside `label`, never alone. */
  glyph: string;
  /** Plain-language explanation, used as the badge's accessible title. */
  description: string;
  /** Reproducibility class, derived — never hand-set. */
  determinism: Determinism;
  /** Which half of the deterministic/nondeterministic split this is. */
  work: ActivityWorkClass;
  /** Short words for the work class, so it is legible without the badge. */
  workLabel: string;
};

const META: Record<
  ActivityOrigin,
  Omit<OriginMeta, "determinism" | "work" | "workLabel">
> = {
  client_evidence: {
    label: "Your input",
    glyph: "◇",
    description:
      "Something you supplied or the app observed in your own input — the question text, a selection, the visible viewport.",
  },
  deterministic_host: {
    label: "Host work",
    glyph: "▣",
    description:
      "Fixed local logic with a defined result — an archive scan, a parse, a normalization, an exact lookup. The same inputs always give the same answer.",
  },
  repeatable_heuristic: {
    label: "Heuristic",
    glyph: "◆",
    description:
      "A repeatable rule — ranking, scoring, selection. Run it twice on the same inputs and you get the same answer, which is not the same as it being a proof.",
  },
  probabilistic_model: {
    label: "Model",
    glyph: "◐",
    description:
      "A language model ran. The same inputs may produce a different answer next time.",
  },
  external_connector: {
    label: "External",
    glyph: "⇄",
    description:
      "A system outside this application answered — an API, a database, a connector. Neither the app nor you control the result.",
  },
  user_decision: {
    label: "You decided",
    glyph: "☑",
    description:
      "A person answered — a permission grant or denial, an Accept or Discard. Not reproducible at all.",
  },
  governed_write: {
    label: "Governed write",
    glyph: "✎",
    description:
      "A durable change that required, and had, your explicit approval.",
  },
};

const WORK_LABEL: Record<ActivityWorkClass, string> = {
  deterministic: "Deterministic work",
  nondeterministic: "Model / external work",
};

export function originMeta(origin: ActivityOrigin): OriginMeta {
  const base = META[origin];
  const work: ActivityWorkClass = isNondeterministicOrigin(origin)
    ? "nondeterministic"
    : "deterministic";
  return {
    ...base,
    determinism: determinismForOrigin(origin),
    work,
    workLabel: WORK_LABEL[work],
  };
}

/** Human wording for a determinism class, for tooltips and detail rows. */
export function determinismLabel(determinism: Determinism): string {
  switch (determinism) {
    case "deterministic":
      return "Deterministic — same inputs, same result";
    case "repeatable":
      return "Repeatable — a rule, not a proof";
    case "probabilistic":
      return "Not guaranteed to repeat";
    case "human":
      return "A person decided";
  }
}
