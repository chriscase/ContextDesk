/**
 * @contextdesk/client — transport-neutral ContextDesk engine client.
 *
 * `EngineClient` is the boundary the import flow consumes; adapters satisfy
 * it. The deterministic mock and the adapter conformance suite live here so
 * every transport (Tauri today, HTTP when cd-server grows the surface) is
 * held to one behavioral contract.
 */
export const CLIENT_PACKAGE = "@contextdesk/client" as const;

export {
  EngineError,
  classifyEngineMessage,
  type EngineClient,
  type EngineErrorCode,
  type EngineEvents,
  type EventRevisionReport,
  type ImportConfidence,
  type ImportRunReport,
  type ImportRunRequest,
  type ImportService,
  type ImportSourceConfidence,
  type TimeService,
  type TriageAdapterCapability,
  type TriageRunOptions,
  type TriageService,
  type TimezoneApplyRequest,
  type TimezoneDeclaration,
  type TimezonePreview,
  type TimezoneSourceStatus,
  type TimezoneState,
  type Unsubscribe,
  unsupportedTriageService,
} from "./engine";
export {
  MockEngineClient,
  createMockEngineClient,
  defaultMockPreview,
  mockPlanToken,
  MOCK_DECLARED_AT_UNIX_SECS,
  type MockScenario,
  type MockTriageScenario,
} from "./mock";
export {
  engineClientConformance,
  triageClientConformance,
  type ConformanceCheck,
  type ConformanceHarness,
  type TriageConformanceHarness,
} from "./conformance";
