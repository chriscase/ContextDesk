import {
  isDiscussionSection,
  type WorkFocus,
} from "./app-location.js";

/**
 * Whether the exact record a deep link named is actually on the page.
 *
 * `none`    — the address named no record; only a surface was opened.
 * `pending` — a record was named and the page has not settled yet.
 * `exact`   — the named record is present and took focus.
 * `absent`  — the page has settled and the named record is not here.
 */
export type RoutedItemPresence = "none" | "pending" | "exact" | "absent";

/** What each surface is called, for copy that does not claim to have found a record. */
function surfaceName(section: string): string | null {
  if (isDiscussionSection(section)) return "Discussion";
  if (section === "workstreams") return "this workstream record";
  if (section === "triage-lane-runner") return "Analyze run history";
  if (section === "triage-evidence-board") return "the evidence board";
  if (section === "triage-capture") return "Capture";
  if (section === "corpus-intake") return "log intake";
  if (section === "cross-exam-heading" || section === "triage-comparison-lab") return "Compare";
  if (section === "decision-heading") return "the accepted-decision record";
  if (section === "export-heading") return "export review";
  if (section === "stage-situation") return "the investigation Situation";
  return null;
}

/**
 * Operator-facing copy for a focused deep link. Names the surface that opened
 * and why, without treating identifiers as labels.
 *
 * A link that lands somewhere but does not show the record it named must not
 * report that it did. An activity row for an imported analysis addressed the
 * evidence board, where imported runs are not rendered; the page announced
 * "Opened the evidence board to the recorded item this activity named" over a
 * board that did not contain it. That is a false success, and it is the reason
 * every "$-link goes somewhere but shows nothing" complaint reads as the
 * product lying rather than as a record simply not being there.
 *
 * So the claim is made only when the record is present. Until the page settles
 * the copy names the surface without claiming a record; once it has settled
 * without the record, it says so.
 */
export function focusArrivalCopy(
  focus: WorkFocus,
  presence: RoutedItemPresence = "none",
): string | null {
  if (focus.item && presence === "absent") {
    const surface = surfaceName(focus.section);
    return surface
      ? `Opened ${surface}, but the record this activity named is not shown here.`
      : "This activity named a record that is not shown here.";
  }
  if (focus.item && presence === "pending") {
    // The surface did open — that part is already true, so it is stated. The
    // record is not claimed until it is actually there, so this sentence only
    // ever gains detail; it is never contradicted by what follows.
    const surface = surfaceName(focus.section);
    return surface ? `Opened ${surface}.` : null;
  }
  if (isDiscussionSection(focus.section)) {
    return focus.item
      ? "Opened Discussion to the comment this activity recorded."
      : "Opened Discussion because this activity recorded a discussion event.";
  }
  if (focus.section === "workstreams") {
    return "Opened this workstream record because the activity named this line of investigation.";
  }
  if (focus.section === "triage-lane-runner") {
    return focus.itemKind === "triage-run"
      ? "Opened the workstream run this activity named. Individual lane attempts have their own workstream addresses."
      : "Opened Analyze run history to the recorded item this activity named.";
  }
  if (focus.section === "triage-evidence-board") {
    return "Opened the evidence board to the recorded item this activity named.";
  }
  if (focus.section === "triage-capture") {
    return "Opened Capture to the recorded item this activity named.";
  }
  if (focus.section === "corpus-intake") {
    return "Opened log intake to the recorded batch this activity named.";
  }
  if (focus.section === "cross-exam-heading" || focus.section === "triage-comparison-lab") {
    return "Opened Compare to the recorded comparison this activity named.";
  }
  if (focus.section === "decision-heading") {
    return "Opened the accepted-decision record this activity named.";
  }
  if (focus.section === "export-heading") {
    return "Opened export review because this activity recorded an export or restore event.";
  }
  if (focus.section === "stage-situation") {
    return "Opened the investigation Situation this activity named.";
  }
  if (focus.item || focus.lane) {
    return "Opened the recorded item this activity named.";
  }
  return null;
}
