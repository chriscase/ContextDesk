import {
  useInvestigationRuntime,
  type CaseV1,
  type CommandOutcome,
  type InvestigationCoordinationActionSuccessV1,
  type ResourceState,
} from "../runtime/public.js";
import {
  CoordinationControl,
  type CoordinationActionCommand,
  type CoordinationFailureKind,
  type CoordinationMutationState,
  type CoordinationReadError,
  type CoordinationResourceState,
} from "./shared/index.js";

type RuntimeFailure = Extract<ResourceState<never>, { status: "failed" }>["error"];

function readError(error: RuntimeFailure): CoordinationReadError {
  if (error.kind === "auth_lost") return "denied";
  if (error.kind === "not_found") return "not_found";
  return "unavailable";
}

function actionError(error: RuntimeFailure): CoordinationFailureKind {
  switch (error.kind) {
    case "coordination_changed": return "changed";
    case "coordination_refused": return "refused";
    case "validation":
    case "input":
      return "validation";
    case "auth_lost": return "auth_lost";
    case "not_found": return "not_found";
    case "unavailable":
      return error.reason === "commit_outcome_unknown" ? "outcome_unknown" : "definitive";
    case "conflict":
    case "server_failure":
    case "unexpected_response":
    case "aborted":
    case "network":
    case "protocol":
    case "unexpected":
    case "lifecycle_changed":
    case "lifecycle_refused":
    case "judgment_conflict":
    case "judgment_refused":
    case "judgment_limit_reached":
      return "definitive";
  }
}

function coordinationResource(
  state: ReturnType<typeof useInvestigationRuntime>["resources"]["coordination"],
): CoordinationResourceState {
  switch (state.status) {
    case "idle": return { status: "idle" };
    case "loading": return state.previous === undefined
      ? { status: "loading" }
      : { status: "loading", previous: state.previous };
    case "ready": return { status: "ready", value: state.value };
    case "failed": return state.previous === undefined
      ? { status: "failed", error: readError(state.error) }
      : { status: "failed", error: readError(state.error), previous: state.previous };
  }
}

function coordinationMutation(
  state: ReturnType<typeof useInvestigationRuntime>["mutations"]["coordination"],
): CoordinationMutationState {
  switch (state.status) {
    case "idle": return { status: "idle" };
    case "running": return { status: "running" };
    case "succeeded": return { status: "succeeded" };
    case "failed": return { status: "failed", error: actionError(state.error) };
  }
}

function commandResult(
  outcome: CommandOutcome<InvestigationCoordinationActionSuccessV1>,
) {
  if (outcome.status === "succeeded") return { status: "succeeded" as const };
  if (outcome.status === "ignored") return outcome;
  return { status: "failed" as const, error: actionError(outcome.error) };
}

/** Runtime-to-presentation adapter for the shared coordination control. */
export function RuntimeCoordinationControl({ investigation }: { readonly investigation: CaseV1 }) {
  const runtime = useInvestigationRuntime();
  const runtimeCommand = runtime.commands.applyCoordinationAction;
  const applyAction: CoordinationActionCommand | null = runtimeCommand === null
    ? null
    : async (input) => commandResult(await runtimeCommand(input));

  return (
    <CoordinationControl
      key={[
        runtime.presentationScopeKey,
        investigation.id,
        investigation.status,
        runtime.identity.id,
        runtime.identity.username,
        runtime.capabilities.canCoordinateSelf ? "self" : "",
        runtime.capabilities.canCoordinateParticipants ? "participants" : "",
      ].join(":")}
      investigationId={investigation.id}
      investigationStatus={investigation.status}
      participants={investigation.participants}
      resource={coordinationResource(runtime.resources.coordination)}
      mutation={coordinationMutation(runtime.mutations.coordination)}
      identity={{ id: runtime.identity.id, username: runtime.identity.username }}
      canCoordinateSelf={runtime.capabilities.canCoordinateSelf}
      canCoordinateParticipants={runtime.capabilities.canCoordinateParticipants}
      applyAction={applyAction}
      refreshCoordination={runtime.refresh.coordination}
    />
  );
}
