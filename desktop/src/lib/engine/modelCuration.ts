/**
 * Model-curation engine adapter. Components consume this module; only the
 * designated engine boundary delegates to the legacy Tauri host bridge.
 */
import {
  hostGetCurationSummary,
  hostListChatModels,
  hostPreviewCurationChange,
  hostSetModelHidden,
  hostSetModelPinned,
  hostSetProviderHidden,
} from "../host";

export type {
  CurationImpactDto,
  CurationSummaryDto,
  ModelOptionDto,
} from "@contextdesk/contracts";

export const getCurationSummary = hostGetCurationSummary;
export const listChatModels = hostListChatModels;
export const previewCurationChange = hostPreviewCurationChange;
export const setModelHidden = hostSetModelHidden;
export const setModelPinned = hostSetModelPinned;
export const setProviderHidden = hostSetProviderHidden;
