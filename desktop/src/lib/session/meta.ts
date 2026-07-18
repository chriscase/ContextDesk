/** Pure provenance helpers for chat message footers (#146 / #155). */

import {
  modelSelectionKey,
  parseModelSelectionKey,
  type MessageMetaDto,
  type ModelOptionDto,
} from "../host";
import type { AppSetupState } from "../preflight";

export function formatMsgMetaFooter(meta: MessageMetaDto): string {
  const parts: string[] = [];
  const model = meta.host_confirmed
    ? meta.model
    : meta.requested_model || meta.model;
  if (model) {
    parts.push(meta.host_confirmed ? model : `requested: ${model}`);
  }
  if (meta.provider_label) parts.push(meta.provider_label);
  else if (meta.provider_kind) parts.push(meta.provider_kind);
  if (meta.base_url) {
    try {
      const u = new URL(meta.base_url);
      parts.push(u.host);
    } catch {
      parts.push(meta.base_url);
    }
  }
  return parts.join(" · ");
}

export function snapshotMessageMeta(args: {
  sessionModel: string | null;
  sessionProvider: string | null;
  modelOptions: ModelOptionDto[];
  defaultModelKey: string;
  setup: AppSetupState;
}): MessageMetaDto {
  const { sessionModel, sessionProvider, modelOptions, defaultModelKey, setup } =
    args;
  let selectionKey = "";
  if (sessionModel && sessionProvider) {
    selectionKey = modelSelectionKey(sessionProvider, sessionModel);
  } else if (sessionModel) {
    selectionKey =
      modelOptions.find((m) => m.id === sessionModel)?.selection_key || "";
  }
  if (!selectionKey) {
    selectionKey =
      defaultModelKey ||
      modelOptions.find((m) => m.is_default)?.selection_key ||
      modelOptions[0]?.selection_key ||
      "";
  }
  const parsed = parseModelSelectionKey(selectionKey);
  const model = sessionModel || parsed.modelId || setup.chatModel || undefined;
  const match = modelOptions.find(
    (m) =>
      m.selection_key === selectionKey ||
      (sessionModel != null && m.id === sessionModel),
  );
  return {
    model: model || undefined,
    requested_model: model || undefined,
    host_confirmed: false,
    provider_label: match?.provider_label || setup.providerLabel || undefined,
    provider_id:
      sessionProvider || match?.provider_id || parsed.providerId || undefined,
    provider_kind: setup.providerKind || undefined,
    base_url: setup.baseUrl?.trim() || undefined,
  };
}
