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
  type TimezoneApplyRequest,
  type TimezoneDeclaration,
  type TimezonePreview,
  type TimezoneSourceStatus,
  type TimezoneState,
  type Unsubscribe,
} from "./engine";
export {
  MockEngineClient,
  createMockEngineClient,
  defaultMockPreview,
  MOCK_DECLARED_AT_UNIX_SECS,
  type MockScenario,
} from "./mock";
export {
  engineClientConformance,
  type ConformanceCheck,
  type ConformanceHarness,
} from "./conformance";
