import {
  DEFAULT_UI_STRATEGY_ID,
  UI_STRATEGIES,
  UI_STRATEGY_IDS,
  isUiStrategyRuntimeCompatible,
  type UiStrategyDescriptor,
  type UiStrategyId,
} from "../../ui-strategy.js";
import {
  INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT,
  type InvestigationStrategyRegistration,
  type InvestigationStrategyRegistrationTable,
  type InvestigationStrategyShellProps,
} from "./contract.js";

export interface InvestigationStrategyRendererProps
  extends InvestigationStrategyShellProps {
  readonly strategy: UiStrategyId | UiStrategyDescriptor;
  readonly registrations: InvestigationStrategyRegistrationTable;
}

function selectedId(value: UiStrategyId | UiStrategyDescriptor): UiStrategyId | null {
  const descriptor = typeof value === "string"
    ? UI_STRATEGIES.find((strategy) => strategy.id === value)
    : value;
  if (!isUiStrategyRuntimeCompatible(descriptor)) return null;
  const candidate = descriptor?.id;
  return UI_STRATEGY_IDS.some((id) => id === candidate)
    ? (candidate as UiStrategyId)
    : null;
}

function isCompatibleRegistration(
  value: InvestigationStrategyRegistration | undefined,
  expectedId: UiStrategyId,
): value is InvestigationStrategyRegistration {
  return value?.id === expectedId &&
    value.presentationContract?.schemaId ===
      INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT.schemaId &&
    value.presentationContract.version ===
      INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT.version &&
    typeof value.component === "function";
}

/**
 * Selects exactly one presentation adapter. Resolution is fail-closed: an
 * unknown strategy, a missing registration, or a registration for another
 * contract version uses the mandatory War Room reference adapter. The
 * renderer forwards shell props unchanged and performs no navigation,
 * preference update, or investigation mutation itself.
 */
export function InvestigationStrategyRenderer({
  strategy,
  registrations,
  ...shellProps
}: InvestigationStrategyRendererProps) {
  const requestedId = selectedId(strategy);
  const requested = requestedId === null ? undefined : registrations[requestedId];
  const useRequested = requestedId !== null &&
    isCompatibleRegistration(requested, requestedId);
  const selected = useRequested
    ? requested
    : registrations[DEFAULT_UI_STRATEGY_ID];
  const expectedId = useRequested ? requestedId : DEFAULT_UI_STRATEGY_ID;

  if (expectedId === null || !isCompatibleRegistration(selected, expectedId)) return null;

  const Strategy = selected.component;
  return <Strategy {...shellProps} />;
}
