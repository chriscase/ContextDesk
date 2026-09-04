import type { ComponentType } from "react";
import type {
  CollectionQueryLocation,
  StageId,
  WorkFocus,
} from "../../app-location.js";
import {
  DEFAULT_UI_STRATEGY_ID,
  type UiStrategyId,
} from "../../ui-strategy.js";

/**
 * Versioned boundary between the application shell and a presentation
 * strategy. This contract deliberately contains no investigation data,
 * capabilities, or mutation functions. Strategies obtain those exclusively
 * from the shared investigation runtime.
 */
export const INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT = Object.freeze({
  schemaId: "cd-collab.investigation_strategy_presentation.v1",
  version: 1,
} as const);

export type InvestigationStrategyView = "overview" | "investigations";

/**
 * Shell-owned navigation intent. Strategies may request a canonical
 * investigation stage/focus, but the shell remains the only history writer.
 */
export interface InvestigationStrategyNavigation {
  readonly investigationId: string;
  readonly stage: StageId;
  readonly focus?: WorkFocus;
}

export interface InvestigationStrategyShellProps {
  readonly view: InvestigationStrategyView;
  readonly focusCaseId: string | null;
  readonly stage: StageId;
  readonly focus?: WorkFocus;
  readonly startSignal?: number;
  readonly onOpenCase: (caseId: string) => void;
  readonly onNavigateInvestigation: (target: InvestigationStrategyNavigation) => void;
  readonly onExitFocus: () => void;
  /** List-route query state owned by the shell; omitted on focused records. */
  readonly collectionQuery?: CollectionQueryLocation;
  /** Requests a canonical list query change; the strategy never writes history. */
  readonly onCollectionQueryChange?: (query: CollectionQueryLocation) => void;
  readonly onOpenAdvancedTools?: (caseId: string, stage: StageId) => void;
  readonly onFocusedCaseTitle?: (title: string | null) => void;
}

export type InvestigationStrategyComponent = ComponentType<InvestigationStrategyShellProps>;

export interface InvestigationStrategyRegistration<
  Id extends UiStrategyId = UiStrategyId,
> {
  readonly id: Id;
  readonly presentationContract: typeof INVESTIGATION_STRATEGY_PRESENTATION_CONTRACT;
  readonly component: InvestigationStrategyComponent;
}

type AlternateUiStrategyId = Exclude<UiStrategyId, typeof DEFAULT_UI_STRATEGY_ID>;

/**
 * The reference strategy is mandatory; alternate strategies are additive.
 * Extending UiStrategyId therefore requires only one new keyed registration
 * at the composition root, without changing the renderer.
 */
export type InvestigationStrategyRegistrationTable = Readonly<
  {
    readonly [DEFAULT_UI_STRATEGY_ID]: InvestigationStrategyRegistration<
      typeof DEFAULT_UI_STRATEGY_ID
    >;
  } & {
    readonly [Id in AlternateUiStrategyId]?: InvestigationStrategyRegistration<Id>;
  }
>;

export function defineInvestigationStrategyRegistrations(
  registrations: InvestigationStrategyRegistrationTable,
): InvestigationStrategyRegistrationTable {
  return registrations;
}
