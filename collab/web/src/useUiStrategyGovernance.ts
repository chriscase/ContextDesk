import {
  UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
  UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
  parseUiStrategyEffective,
  type UiStrategyEffectiveV1,
  type UiStrategyId,
} from "@cd-collab/contracts/admin";
import { useCallback, useEffect, useRef, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";

export type UiStrategyGovernanceStatus = "idle" | "loading" | "ready" | "saving" | "unavailable" | "conflict";
export const UI_STRATEGY_POLICY_CHANGED_EVENT = "contextdesk:ui-strategy-policy-changed";

const SAFE_ENABLED_IDS: UiStrategyId[] = ["war-room"];
const SAFE_SELECTABLE_IDS: UiStrategyId[] = [];
Object.freeze(SAFE_ENABLED_IDS);
Object.freeze(SAFE_SELECTABLE_IDS);
const SAFE_EFFECTIVE: UiStrategyEffectiveV1 = Object.freeze<UiStrategyEffectiveV1>({
  schemaId: UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
  policyRevision: 0,
  preferenceRevision: 0,
  preferredId: null,
  effectiveId: "war-room",
  defaultId: "war-room",
  enabledIds: SAFE_ENABLED_IDS,
  selectableIds: SAFE_SELECTABLE_IDS,
  canSelect: false,
  source: "safe_reference",
});

export interface UiStrategyGovernanceState {
  effective: UiStrategyEffectiveV1;
  status: UiStrategyGovernanceStatus;
  message: string;
  savePreference(strategyId: UiStrategyId): Promise<boolean>;
  refresh(): void;
}

/**
 * Shell-owned strategy policy client. Responses are fenced by immutable
 * identity plus authority generation; strategies never import this hook.
 */
export function useUiStrategyGovernance(input: {
  identityId: string | null;
  authorityGeneration: number;
  enabled: boolean;
}): UiStrategyGovernanceState {
  const [effective, setEffective] = useState<UiStrategyEffectiveV1>(SAFE_EFFECTIVE);
  const [status, setStatus] = useState<UiStrategyGovernanceStatus>("idle");
  const [message, setMessage] = useState("");
  const [generation, setGeneration] = useState(0);
  const requestRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const reconciliationNoticeRef = useRef("");
  const latestRef = useRef(input);
  latestRef.current = input;

  useEffect(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    if (!input.enabled || !input.identityId) {
      reconciliationNoticeRef.current = "";
      setEffective(SAFE_EFFECTIVE);
      setStatus("idle");
      setMessage("");
      return () => {
        controller.abort();
        if (activeRequestRef.current === controller) activeRequestRef.current = null;
      };
    }
    setEffective(SAFE_EFFECTIVE);
    setStatus("loading");
    setMessage(reconciliationNoticeRef.current || "Loading the workspace investigation-experience policy…");
    void protectedApiFetch("/api/ui-strategies/effective", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`policy request failed:${response.status}`);
        return parseUiStrategyEffective(await response.json());
      })
      .then((loaded) => {
        if (requestRef.current !== requestId || controller.signal.aborted) return;
        const latest = latestRef.current;
        if (latest.identityId !== input.identityId || latest.authorityGeneration !== input.authorityGeneration) return;
        setEffective(loaded);
        setStatus("ready");
        const reconciled = reconciliationNoticeRef.current;
        reconciliationNoticeRef.current = "";
        setMessage(reconciled ? `${reconciled} Current policy is loaded.` : "");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestRef.current !== requestId) return;
        setEffective(SAFE_EFFECTIVE);
        setStatus("unavailable");
        setMessage(error instanceof Error && error.name === "AbortError"
          ? ""
          : "Investigation-experience policy is unavailable. War Room is active and personal selection is disabled.");
      });
    return () => {
      controller.abort();
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
    };
  }, [input.enabled, input.identityId, input.authorityGeneration, generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    const onPolicyChanged = () => refresh();
    window.addEventListener(UI_STRATEGY_POLICY_CHANGED_EVENT, onPolicyChanged);
    return () => window.removeEventListener(UI_STRATEGY_POLICY_CHANGED_EVENT, onPolicyChanged);
  }, [refresh]);

  const savePreference = useCallback(async (strategyId: UiStrategyId): Promise<boolean> => {
    const start = latestRef.current;
    if (!start.enabled || !start.identityId || status !== "ready" || !effective.selectableIds.includes(strategyId)) {
      return false;
    }
    const requestId = ++requestRef.current;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setStatus("saving");
    setMessage(`Saving ${strategyId} as your investigation experience…`);
    try {
      const response = await protectedApiFetch("/api/ui-strategies/preference", {
        method: "PUT",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
          expectedPolicyRevision: effective.policyRevision,
          expectedPreferenceRevision: effective.preferenceRevision,
          strategyId,
        }),
      });
      if (requestRef.current !== requestId) return false;
      const latest = latestRef.current;
      if (latest.identityId !== start.identityId || latest.authorityGeneration !== start.authorityGeneration) return false;
      if (response.status === 409) {
        setEffective(SAFE_EFFECTIVE);
        setStatus("conflict");
        reconciliationNoticeRef.current = "Your preference was not saved because the workspace policy or your saved choice changed.";
        setMessage(`${reconciliationNoticeRef.current} War Room is active while current authority is reloaded.`);
        setGeneration((value) => value + 1);
        return false;
      }
      if (!response.ok) throw new Error(`preference request failed:${response.status}`);
      const saved = parseUiStrategyEffective(await response.json());
      setEffective(saved);
      setStatus("ready");
      setMessage(`${strategyId} is now your saved investigation experience.`);
      return true;
    } catch {
      if (requestRef.current !== requestId) return false;
      setEffective(SAFE_EFFECTIVE);
      setStatus("unavailable");
      reconciliationNoticeRef.current = "Your preference was not confirmed.";
      setMessage(`${reconciliationNoticeRef.current} War Room is active while current authority is reloaded.`);
      setGeneration((value) => value + 1);
      return false;
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
    }
  }, [effective, status]);

  return { effective, status, message, savePreference, refresh };
}
