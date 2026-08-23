/**
 * Single Experiment Lab import entrypoint.
 *
 * Accepts experiment packages, strategy packages, and hermetic bench-run /
 * bench-compare artifacts (converted to strategy_package.v1).
 */

import { ContractViolation } from "./parse.js";
import {
  convertBenchArtifactImport,
  isBenchArtifactSchemaId,
} from "./bench-artifact.js";
import { parseExperimentImport } from "./experiment.js";
import {
  STRATEGY_PACKAGE_SCHEMA_ID,
  parseStrategyPackage,
  type LabImport,
} from "./trace.js";

export type { LabImport } from "./trace.js";

export function parseLabImport(raw: unknown): LabImport {
  if (!raw || typeof raw !== "object") {
    throw new ContractViolation(
      "$",
      "expected experiment, strategy package, or bench-run artifact object",
    );
  }
  const record = raw as { schemaId?: unknown; schema_id?: unknown };
  const schemaId = record.schemaId ?? record.schema_id;
  if (schemaId === STRATEGY_PACKAGE_SCHEMA_ID) {
    return { kind: "strategy", package: parseStrategyPackage(raw) };
  }
  if (isBenchArtifactSchemaId(schemaId)) {
    return { kind: "strategy", package: convertBenchArtifactImport(raw) };
  }
  if (record.schemaId == null && record.schema_id == null) {
    throw new ContractViolation("$", "expected experiment or strategy package object");
  }
  // Experiment packages / summaries use camelCase schemaId only.
  if (typeof record.schemaId !== "string") {
    throw new ContractViolation("$.schemaId", "expected experiment schemaId");
  }
  return { kind: "experiment", envelope: parseExperimentImport(raw) };
}
