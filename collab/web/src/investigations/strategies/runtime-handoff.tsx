import {
  useInvestigationRuntime,
  type CaseV1,
  type ContributionV1,
  type MutationState,
  type ResourceState,
} from "../runtime/public.js";
import {
  HandoffPanel,
  type HandoffContributionRecord,
  type HandoffCreateInput,
  type HandoffCreateResult,
  type HandoffMutationState,
  type HandoffResourceState,
} from "./shared/index.js";

type RuntimeFailure = Extract<ResourceState<never>, { status: "failed" }>["error"];

function handoffReadError(error: RuntimeFailure): string {
  if (error.kind === "auth_lost") {
    return "Your access changed while this view was open. Sign in again before loading handoff facts.";
  }
  if (error.kind === "not_found") {
    return "This investigation is no longer available in the current scope.";
  }
  return "Recorded handoff facts could not be loaded right now.";
}

function toHandoffContributions(
  state: ResourceState<readonly ContributionV1[]>,
): HandoffResourceState<readonly HandoffContributionRecord[]> {
  switch (state.status) {
    case "idle":
      return { status: "idle" };
    case "loading":
      return state.previous === undefined
        ? { status: "loading" }
        : { status: "loading", previous: state.previous };
    case "ready":
      return { status: "ready", value: state.value };
    case "failed":
      return state.previous === undefined
        ? { status: "failed", error: handoffReadError(state.error) }
        : { status: "failed", error: handoffReadError(state.error), previous: state.previous };
  }
}

function toHandoffMutation(
  state: MutationState<ContributionV1>,
): HandoffMutationState {
  switch (state.status) {
    case "idle":
      return { status: "idle" };
    case "running":
      return { status: "running" };
    case "succeeded":
      return { status: "succeeded", value: state.value };
    case "failed":
      return { status: "failed", error: { kind: state.error.kind } };
  }
}

/**
 * Runtime-to-presentation adapter for the shared handoff panel.
 *
 * Strategies own placement and visual composition; this adapter is the only
 * place that maps the public runtime's resource/command vocabulary into the
 * structural, transport-free shared kit contract.
 */
export function RuntimeHandoffPanel({ investigation }: { readonly investigation: CaseV1 }) {
  const runtime = useInvestigationRuntime();
  const command = runtime.commands.createContribution;
  const createHandoff = runtime.capabilities.canContribute && command !== null
    ? async (input: HandoffCreateInput): Promise<HandoffCreateResult> => {
        const result = await command(input);
        if (result.status === "failed") {
          return { status: "failed", error: { kind: result.error.kind } };
        }
        return result;
      }
    : null;

  return (
    <HandoffPanel
      key={`${runtime.identity.id}:${runtime.identity.username}:${investigation.id}`}
      investigationId={investigation.id}
      investigation={investigation}
      contributions={toHandoffContributions(runtime.resources.contributions)}
      createContribution={createHandoff}
      refreshContributions={runtime.refresh.contributions}
      mutationState={toHandoffMutation(runtime.mutations.createContribution)}
    />
  );
}
