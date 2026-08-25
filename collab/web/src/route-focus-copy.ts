import {
  isDiscussionSection,
  type WorkFocus,
} from "./app-location.js";

/**
 * Operator-facing copy for a focused deep link. Names the surface that opened
 * and why, without treating identifiers as labels.
 */
export function focusArrivalCopy(focus: WorkFocus): string | null {
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
