/** Governed provider/model curation contract (#678). */
import { checkObject, checkValue, f, type ObjectShape } from "./parse";

export const MODEL_SELECTION_PREFIX = "cd.model.v1:" as const;

export const MODEL_AVAILABILITY = [
  "discovered",
  "configured_unverified",
] as const;
export type ModelAvailability = (typeof MODEL_AVAILABILITY)[number];

export const MODEL_READINESS_ROLES = [
  "chat",
  "embedding",
  "reranker",
  "unknown",
] as const;
export type ModelReadinessRole = (typeof MODEL_READINESS_ROLES)[number];

export const MODEL_READINESS_STATES = [
  "verified",
  "limited",
  "failed",
  "stale",
  "unverified",
] as const;
export type ModelReadinessState = (typeof MODEL_READINESS_STATES)[number];

export const MODEL_READINESS_BASES = ["measured", "name_hint"] as const;
export type ModelReadinessBasis = (typeof MODEL_READINESS_BASES)[number];

export type ModelReadiness = {
  role: ModelReadinessRole;
  state: ModelReadinessState;
  basis: ModelReadinessBasis;
  tested_at: number | null;
  detail: string;
};

export type ModelSelection = { providerId: string | null; modelId: string };

export type ModelOptionDto = {
  id: string;
  label: string;
  selection_key: string;
  provider_id: string;
  provider_label: string;
  group: string;
  is_default: boolean;
  tools_enabled: boolean;
  tools_disabled_reason: string | null;
  availability: ModelAvailability;
  availability_detail: string | null;
  /** Optional only for rolling compatibility with older desktop hosts. */
  readiness?: ModelReadiness;
  hidden: boolean;
  hidden_by: string | null;
  pinned_rank: number | null;
};

export type CurationImpactDto = {
  affects_default: boolean;
  replacement_key: string | null;
  replacement_label: string | null;
  remaining_visible: number;
  state_token: string;
};

export type CurationSummaryDto = {
  hidden_models: number;
  hidden_providers: number;
  pinned_models: number;
};

const utf8 = new TextEncoder();

function component(value: string): string {
  return `${utf8.encode(value).length}:${value}`;
}

/** Collision-safe key used for every new provider/model selection write. */
export function modelSelectionKey(providerId: string, modelId: string): string {
  const provider = providerId.trim();
  const model = modelId.trim();
  return `${MODEL_SELECTION_PREFIX}${component(provider)}${component(model)}`;
}

function takeComponent(input: string): [string, string] | null {
  const colon = input.indexOf(":");
  if (colon <= 0 || !/^\d+$/.test(input.slice(0, colon))) return null;
  const wanted = Number(input.slice(0, colon));
  if (!Number.isSafeInteger(wanted)) return null;
  const body = input.slice(colon + 1);
  let chars = 0;
  let bytes = 0;
  for (const char of body) {
    const next = bytes + utf8.encode(char).length;
    if (next > wanted) return null;
    bytes = next;
    chars += char.length;
    if (bytes === wanted) return [body.slice(0, chars), body.slice(chars)];
  }
  return wanted === 0 ? ["", body] : null;
}

/** Read canonical keys and legacy `provider::model` / bare-model values. */
export function parseModelSelectionKey(key: string): ModelSelection {
  const value = key.trim();
  if (value.startsWith(MODEL_SELECTION_PREFIX)) {
    const provider = takeComponent(value.slice(MODEL_SELECTION_PREFIX.length));
    const model = provider && takeComponent(provider[1]);
    if (
      provider &&
      model &&
      model[1] === "" &&
      provider[0] !== "" &&
      model[0] !== ""
    ) {
      return { providerId: provider[0], modelId: model[0] };
    }
    return { providerId: null, modelId: "" };
  }
  const separator = value.indexOf("::");
  if (separator > 0 && separator + 2 < value.length) {
    return {
      providerId: value.slice(0, separator),
      modelId: value.slice(separator + 2),
    };
  }
  return { providerId: null, modelId: value };
}

const modelOptionShape: ObjectShape = {
  id: f.req(f.str),
  label: f.req(f.str),
  selection_key: f.req(f.str),
  provider_id: f.req(f.str),
  provider_label: f.req(f.str),
  group: f.req(f.str),
  is_default: f.req(f.bool),
  tools_enabled: f.req(f.bool),
  tools_disabled_reason: f.nul(f.str),
  availability: f.req(f.en(...MODEL_AVAILABILITY)),
  availability_detail: f.nul(f.str),
  readiness: f.opt(
    f.obj({
      role: f.req(f.en(...MODEL_READINESS_ROLES)),
      state: f.req(f.en(...MODEL_READINESS_STATES)),
      basis: f.req(f.en(...MODEL_READINESS_BASES)),
      tested_at: f.nul(f.i64),
      detail: f.req(f.str),
    }),
  ),
  hidden: f.req(f.bool),
  hidden_by: f.nul(f.str),
  pinned_rank: f.nul(f.u64),
};

export function parseModelOptions(value: unknown): ModelOptionDto[] {
  checkValue("modelOptions", f.arr(f.obj(modelOptionShape)), value);
  const options = value as ModelOptionDto[];
  for (const [index, option] of options.entries()) {
    const parsed = parseModelSelectionKey(option.selection_key);
    if (
      parsed.providerId !== option.provider_id ||
      parsed.modelId !== option.id
    ) {
      throw new Error(
        `modelOptions[${index}].selection_key: identity does not match provider_id/id`,
      );
    }
  }
  return options;
}

export function parseCurationImpact(value: unknown): CurationImpactDto {
  checkObject(
    "curationImpact",
    {
      affects_default: f.req(f.bool),
      replacement_key: f.nul(f.str),
      replacement_label: f.nul(f.str),
      remaining_visible: f.req(f.u64),
      state_token: f.req(f.str),
    },
    value,
  );
  return value as CurationImpactDto;
}

export function parseCurationSummary(value: unknown): CurationSummaryDto {
  checkObject(
    "curationSummary",
    {
      hidden_models: f.req(f.u64),
      hidden_providers: f.req(f.u64),
      pinned_models: f.req(f.u64),
    },
    value,
  );
  return value as CurationSummaryDto;
}
