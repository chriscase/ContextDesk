/**
 * @contextdesk/react — headless React state and hooks over the engine client.
 *
 * Target shape (design handoff §7): `EngineProvider` plus domain hooks
 * (useExplorerQuery, useFacets, useNoiseLens, useInvestigation, useTurn…).
 * This batch ships only the package identity; hooks land with batch B5.
 */
export const REACT_PACKAGE = "@contextdesk/react" as const;
