import { describe, expect, it } from "vitest";
import type { InvestigationRuntimeProviderProps } from "./public.js";
import * as publicRuntime from "./public.js";

const STRATEGY_FACING_PROPS: InvestigationRuntimeProviderProps = {
  identityKey: "alice",
  authorityKey: "alice-authority-v1",
  capabilities: ["investigation:read"],
  readOnly: false,
  active: true,
  focusCaseId: null,
  isInvestigationLocation: true,
  onOpenCreated: () => undefined,
  children: null,
};

describe("investigation runtime public surface", () => {
  it("does not expose transport or protected-fetch internals at runtime", () => {
    expect(Object.keys(publicRuntime).sort()).toEqual([
      "InvestigationRuntimeProvider",
      "MAX_EVIDENCE_UPLOAD_BYTES",
      "selectEvidenceInventory",
      "selectResourceView",
      "useInvestigationRuntime",
    ]);
  });

  it("gives strategies no transport-injection seam on the provider contract", () => {
    // The guard here is the type error itself: typecheck fails if a `gateway`
    // prop ever returns to the strategy-facing contract. Transport reaches the
    // provider only through the runtime's internal test harness.
    // @ts-expect-error Runtime V1 accepts no transport from a strategy.
    const smuggled: InvestigationRuntimeProviderProps = { ...STRATEGY_FACING_PROPS, gateway: {} };
    expect(smuggled.capabilities).toEqual(["investigation:read"]);
  });
});
