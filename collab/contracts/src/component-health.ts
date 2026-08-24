import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const COMPONENT_HEALTH_SCHEMA_ID = "cd-collab.component-health.v1" as const;

export const COMPONENT_HEALTH_COMPONENT_IDS = [
  "war_room_service",
  "desktop",
  "cli",
  "host_bridge",
] as const;
export type ComponentHealthComponentId = (typeof COMPONENT_HEALTH_COMPONENT_IDS)[number];

export const COMPONENT_HEALTH_NOTICES = [
  "Compatibility is shown only when an explicit check is reported; missing peers are not treated as compatible.",
  "Update state is informational. This panel never downloads or installs anything.",
  "Desktop, CLI, and host bridge identity is shown only when that component reports it.",
] as const;
export type ComponentHealthNotice = (typeof COMPONENT_HEALTH_NOTICES)[number];

export type ComponentHealthDataMode = "runtime" | "synthetic_fixture";
export type ComponentHealthSource = ComponentHealthDataMode | "not_reported";
export type ComponentHealthReportStatus = "reported" | "not_reported";
export type ComponentHealthCompatibilityStatus =
  | "compatible"
  | "incompatible"
  | "not_evaluated";
export type ComponentHealthCompatibilityScope =
  | "component_health_contract"
  | "application_protocol"
  | "not_evaluated";
export type ComponentHealthStorageMigrationState =
  | "current"
  | "pending"
  | "unknown"
  | "not_applicable";
export type ComponentHealthUpdateState =
  | "current"
  | "available"
  | "unknown"
  | "not_configured";

export interface ComponentHealthProtocolV1 {
  name: string;
  version: string;
}

export interface ComponentHealthStorageMigrationV1 {
  state: ComponentHealthStorageMigrationState;
  current: string | null;
  target: string | null;
}

export interface ComponentHealthCompatibilityV1 {
  status: ComponentHealthCompatibilityStatus;
  scope: ComponentHealthCompatibilityScope;
  detail: string;
}

export interface ComponentHealthUpdateV1 {
  state: ComponentHealthUpdateState;
  targetVersion: string | null;
}

export interface ComponentHealthComponentV1 {
  id: ComponentHealthComponentId;
  label: string;
  source: ComponentHealthSource;
  reportStatus: ComponentHealthReportStatus;
  version: string | null;
  commit: string | null;
  protocol: ComponentHealthProtocolV1 | null;
  storageMigration: ComponentHealthStorageMigrationV1;
  compatibility: ComponentHealthCompatibilityV1;
  update: ComponentHealthUpdateV1;
}

export interface ComponentHealthResponseV1 {
  schemaId: typeof COMPONENT_HEALTH_SCHEMA_ID;
  generatedAt: string;
  dataMode: ComponentHealthDataMode;
  components: ComponentHealthComponentV1[];
  notices: ComponentHealthNotice[];
}

export interface ComponentHealthObservationV1 {
  id: ComponentHealthComponentId;
  source: ComponentHealthDataMode;
  version?: string | null;
  commit?: string | null;
  protocol?: ComponentHealthProtocolV1 | null;
  storageMigration?: ComponentHealthStorageMigrationV1 | null;
  compatibility?: ComponentHealthCompatibilityV1 | null;
  update?: ComponentHealthUpdateV1 | null;
}

export interface ComponentHealthProjectorInputV1 {
  generatedAt: string;
  dataMode: ComponentHealthDataMode;
  observations: readonly ComponentHealthObservationV1[];
}

const protocolShape: ObjectShape = {
  name: f.req(f.nstr),
  version: f.req(f.nstr),
};

const storageMigrationShape: ObjectShape = {
  state: f.req(f.en("current", "pending", "unknown", "not_applicable")),
  current: f.nul(f.nstr),
  target: f.nul(f.nstr),
};

const compatibilityShape: ObjectShape = {
  status: f.req(f.en("compatible", "incompatible", "not_evaluated")),
  scope: f.req(f.en("component_health_contract", "application_protocol", "not_evaluated")),
  detail: f.req(f.nstr),
};

const updateShape: ObjectShape = {
  state: f.req(f.en("current", "available", "unknown", "not_configured")),
  targetVersion: f.nul(f.nstr),
};

const componentShape: ObjectShape = {
  id: f.req(f.en(...COMPONENT_HEALTH_COMPONENT_IDS)),
  label: f.req(f.en("War Room service", "Desktop", "CLI", "Host bridge")),
  source: f.req(f.en("runtime", "synthetic_fixture", "not_reported")),
  reportStatus: f.req(f.en("reported", "not_reported")),
  version: f.nul(f.nstr),
  commit: f.nul(f.nstr),
  protocol: f.nul(f.obj(protocolShape)),
  storageMigration: f.req(f.obj(storageMigrationShape)),
  compatibility: f.req(f.obj(compatibilityShape)),
  update: f.req(f.obj(updateShape)),
};

const responseShape: ObjectShape = {
  schemaId: f.req(f.en(COMPONENT_HEALTH_SCHEMA_ID)),
  generatedAt: f.req(f.nstr),
  dataMode: f.req(f.en("runtime", "synthetic_fixture")),
  components: f.req(f.arr(f.obj(componentShape))),
  notices: f.req(f.arr(f.en(...COMPONENT_HEALTH_NOTICES))),
};

const COMPONENT_LABELS: Record<ComponentHealthComponentId, string> = {
  war_room_service: "War Room service",
  desktop: "Desktop",
  cli: "CLI",
  host_bridge: "Host bridge",
};

function notReportedComponent(id: ComponentHealthComponentId): ComponentHealthComponentV1 {
  return {
    id,
    label: COMPONENT_LABELS[id],
    source: "not_reported",
    reportStatus: "not_reported",
    version: null,
    commit: null,
    protocol: null,
    storageMigration: {
      state: id === "war_room_service" ? "unknown" : "not_applicable",
      current: null,
      target: null,
    },
    compatibility: {
      status: "not_evaluated",
      scope: "not_evaluated",
      detail: "No identity or compatibility report was supplied.",
    },
    update: { state: "unknown", targetVersion: null },
  };
}

function hasReportedValue(observation: ComponentHealthObservationV1): boolean {
  return (
    observation.version !== undefined ||
    observation.commit !== undefined ||
    observation.protocol !== undefined ||
    observation.storageMigration !== undefined ||
    observation.compatibility !== undefined ||
    observation.update !== undefined
  );
}

function projectedComponent(
  observation: ComponentHealthObservationV1,
): ComponentHealthComponentV1 {
  const fallback = notReportedComponent(observation.id);
  const reported = hasReportedValue(observation);
  return {
    ...fallback,
    source: reported ? observation.source : "not_reported",
    reportStatus: reported ? "reported" : "not_reported",
    ...(observation.version === undefined ? {} : { version: observation.version }),
    ...(observation.commit === undefined ? {} : { commit: observation.commit }),
    ...(observation.protocol === undefined ? {} : { protocol: observation.protocol }),
    ...(observation.storageMigration === undefined
      ? {}
      : { storageMigration: observation.storageMigration ?? fallback.storageMigration }),
    ...(observation.compatibility === undefined
      ? {}
      : { compatibility: observation.compatibility ?? fallback.compatibility }),
    ...(observation.update === undefined
      ? {}
      : { update: observation.update ?? fallback.update }),
  };
}

/**
 * Project provider observations into a stable, bounded response. Missing
 * component reports remain visible as unknown rather than being inferred.
 */
export function projectComponentHealth(
  input: ComponentHealthProjectorInputV1,
): ComponentHealthResponseV1 {
  if (!input.generatedAt.trim()) {
    throw new ContractViolation("$.generatedAt", "expected non-empty string");
  }
  const observations = new Map<ComponentHealthComponentId, ComponentHealthObservationV1>();
  for (const observation of input.observations) {
    if (!COMPONENT_HEALTH_COMPONENT_IDS.includes(observation.id)) {
      throw new ContractViolation(
        "$.observations",
        `unknown component ${String(observation.id)}`,
      );
    }
    if (observation.source !== input.dataMode) {
      throw new ContractViolation(
        "$.observations",
        `component ${observation.id} source must match dataMode ${input.dataMode}`,
      );
    }
    if (observations.has(observation.id)) {
      throw new ContractViolation("$.observations", `duplicate component ${observation.id}`);
    }
    observations.set(observation.id, observation);
  }
  const components = COMPONENT_HEALTH_COMPONENT_IDS.map((id) => {
    const observation = observations.get(id);
    return observation ? projectedComponent(observation) : notReportedComponent(id);
  });
  const response: ComponentHealthResponseV1 = {
    schemaId: COMPONENT_HEALTH_SCHEMA_ID,
    generatedAt: input.generatedAt,
    dataMode: input.dataMode,
    components,
    notices: [...COMPONENT_HEALTH_NOTICES],
  };
  parseComponentHealthResponse(response);
  return response;
}

function assertComponentInvariants(response: ComponentHealthResponseV1): void {
  if (response.components.length !== COMPONENT_HEALTH_COMPONENT_IDS.length) {
    throw new ContractViolation(
      "$.components",
      `expected exactly ${COMPONENT_HEALTH_COMPONENT_IDS.length} components`,
    );
  }
  for (const [index, component] of response.components.entries()) {
    const expectedId = COMPONENT_HEALTH_COMPONENT_IDS[index];
    if (component.id !== expectedId) {
      throw new ContractViolation(
        `$.components[${index}].id`,
        `expected canonical component order with ${expectedId}`,
      );
    }
    if (component.label !== COMPONENT_LABELS[expectedId]) {
      throw new ContractViolation(
        `$.components[${index}].label`,
        `expected ${COMPONENT_LABELS[expectedId]}`,
      );
    }
    if (component.source === "not_reported" && component.reportStatus !== "not_reported") {
      throw new ContractViolation(
        `$.components[${index}].reportStatus`,
        "not_reported source cannot claim a report",
      );
    }
    if (component.reportStatus === "not_reported") {
      if (
        component.version !== null ||
        component.commit !== null ||
        component.protocol !== null ||
        component.compatibility.status !== "not_evaluated" ||
        component.compatibility.scope !== "not_evaluated"
      ) {
        throw new ContractViolation(
          `$.components[${index}]`,
          "not-reported component contains reported identity or compatibility",
        );
      }
    }
    if (
      component.compatibility.status === "not_evaluated" &&
      component.compatibility.scope !== "not_evaluated"
    ) {
      throw new ContractViolation(
        `$.components[${index}].compatibility.scope`,
        "not_evaluated compatibility must have not_evaluated scope",
      );
    }
    if (
      component.compatibility.status !== "not_evaluated" &&
      component.compatibility.scope === "not_evaluated"
    ) {
      throw new ContractViolation(
        `$.components[${index}].compatibility.scope`,
        "evaluated compatibility must name its scope",
      );
    }
    if (
      component.update.state === "available" &&
      component.update.targetVersion === null
    ) {
      throw new ContractViolation(
        `$.components[${index}].update.targetVersion`,
        "available update must include a target version",
      );
    }
    if (component.update.state !== "available" && component.update.targetVersion !== null) {
      throw new ContractViolation(
        `$.components[${index}].update.targetVersion`,
        "only an available update may include a target version",
      );
    }
  }
}

export function parseComponentHealthResponse(raw: unknown): ComponentHealthResponseV1 {
  checkObject("$", responseShape, raw);
  const response = raw as ComponentHealthResponseV1;
  assertComponentInvariants(response);
  if (
    response.notices.length !== COMPONENT_HEALTH_NOTICES.length ||
    new Set(response.notices).size !== response.notices.length ||
    COMPONENT_HEALTH_NOTICES.some((notice) => !response.notices.includes(notice))
  ) {
    throw new ContractViolation("$.notices", "expected each required notice exactly once");
  }
  return response;
}
