import type {
  ArtifactV1,
  CaseV1,
  ContributionV1,
  InvestigationLifecycleV1,
} from "@cd-collab/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GatewayResult,
  InvestigationGateway,
} from "../gateway.js";
import {
  makeArchiveAllowedLifecycle,
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
  makeEvidenceUploadSuccess,
  makePopulatedCase,
  makeRestoreAllowedLifecycle,
  makeSparseImportedCase,
} from "../testkit/fixtures.js";
import { createDeferred, type Deferred } from "../testkit/promises.js";
import { useActiveInvestigation } from "./use-active-investigation.js";
import { useInvestigationList } from "./use-investigation-list.js";

afterEach(cleanup);

const failedUnexpected = async <T,>(): Promise<GatewayResult<T>> => ({
  ok: false,
  error: { kind: "unexpected" },
});

function gatewayWith(overrides: Partial<InvestigationGateway>): InvestigationGateway {
  return {
    listInvestigations: () => failedUnexpected(),
    getInvestigation: () => failedUnexpected(),
    createInvestigation: () => failedUnexpected(),
    listEvidence: () => failedUnexpected(),
    listContributions: () => failedUnexpected(),
    uploadEvidence: () => failedUnexpected(),
    getLifecycle: () => failedUnexpected(),
    applyLifecycleAction: () => failedUnexpected(),
    ...overrides,
  };
}

interface ReadRequest<T> {
  readonly investigationId: string;
  readonly signal: AbortSignal;
  readonly deferred: Deferred<GatewayResult<T>>;
}

interface ReadRequests {
  readonly investigation: ReadRequest<CaseV1>[];
  readonly evidence: ReadRequest<readonly ArtifactV1[]>[];
  readonly contributions: ReadRequest<readonly ContributionV1[]>[];
  readonly lifecycle: ReadRequest<InvestigationLifecycleV1>[];
}

function deferredReadGateway(): { gateway: InvestigationGateway; requests: ReadRequests } {
  const requests: ReadRequests = {
    investigation: [],
    evidence: [],
    contributions: [],
    lifecycle: [],
  };
  const capture = <T,>(
    lane: ReadRequest<T>[],
    investigationId: string,
    signal: AbortSignal,
  ): Promise<GatewayResult<T>> => {
    const deferred = createDeferred<GatewayResult<T>>();
    lane.push({ investigationId, signal, deferred });
    return deferred.promise;
  };
  return {
    requests,
    gateway: gatewayWith({
      getInvestigation: (investigationId, { signal }) =>
        capture(requests.investigation, investigationId, signal),
      listEvidence: (investigationId, { signal }) =>
        capture(requests.evidence, investigationId, signal),
      listContributions: (investigationId, { signal }) =>
        capture(requests.contributions, investigationId, signal),
      getLifecycle: (investigationId, { signal }) =>
        capture(requests.lifecycle, investigationId, signal),
    }),
  };
}

function useController(
  gateway: InvestigationGateway,
  props: {
    investigationId: string | null;
    active: boolean;
    identityKey: string;
    authorityKey: string;
  },
) {
  return useActiveInvestigation({ gateway, ...props });
}

describe("useActiveInvestigation", () => {
  it("publishes authoritative case, upload members, and lifecycle into current resources", async () => {
    const originalEvidence = makeEvidenceList().artifacts;
    const originalContributions = makeContributionList().contributions;
    const gateway = gatewayWith({
      getInvestigation: async () => ({ ok: true, value: makePopulatedCase() }),
      listEvidence: async () => ({ ok: true, value: originalEvidence }),
      listContributions: async () => ({ ok: true, value: originalContributions }),
      getLifecycle: async () => ({ ok: true, value: makeArchiveAllowedLifecycle() }),
    });
    const { result } = renderHook(() => useController(gateway, {
      investigationId: makePopulatedCase().id,
      active: true,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    }));
    await waitFor(() => expect(result.current.lifecycle.status).toBe("ready"));

    const publishedCase = { ...makePopulatedCase(), title: "Server-confirmed title" };
    const upload = makeEvidenceUploadSuccess();
    const publishedArtifact = { ...upload.artifact, filename: "server-confirmed.log" };
    const publishedSummary = { ...upload.summary, body: "Server-confirmed summary" };
    const publishedLifecycle = makeRestoreAllowedLifecycle();
    act(() => {
      result.current.publishInvestigation(publishedCase);
      result.current.publishEvidence(publishedArtifact, publishedSummary);
      result.current.publishLifecycle(publishedLifecycle);
    });

    expect(result.current.investigation).toEqual({ status: "ready", value: publishedCase });
    expect(result.current.evidence.status).toBe("ready");
    if (result.current.evidence.status !== "ready") throw new Error("expected evidence");
    expect(result.current.evidence.value).toHaveLength(originalEvidence.length);
    expect(result.current.evidence.value).toContainEqual(publishedArtifact);
    expect(result.current.contributions.status).toBe("ready");
    if (result.current.contributions.status !== "ready") throw new Error("expected contributions");
    expect(result.current.contributions.value).toHaveLength(originalContributions.length);
    expect(result.current.contributions.value).toContainEqual(publishedSummary);
    expect(result.current.lifecycle).toEqual({ status: "ready", value: publishedLifecycle });
    expect(originalEvidence).toEqual(makeEvidenceList().artifacts);
    expect(originalContributions).toEqual(makeContributionList().contributions);
  });

  it("keeps loading and refresh-failure visible while publishing prior data", async () => {
    const evidenceRefresh = createDeferred<GatewayResult<readonly ArtifactV1[]>>();
    const lifecycleRefresh = createDeferred<GatewayResult<InvestigationLifecycleV1>>();
    let evidenceReads = 0;
    let lifecycleReads = 0;
    const gateway = gatewayWith({
      getInvestigation: async () => ({ ok: true, value: makePopulatedCase() }),
      listEvidence: () => ++evidenceReads === 1
        ? Promise.resolve({ ok: true, value: makeEvidenceList().artifacts })
        : evidenceRefresh.promise,
      listContributions: async () => ({
        ok: true,
        value: makeContributionList().contributions,
      }),
      getLifecycle: () => ++lifecycleReads === 1
        ? Promise.resolve({ ok: true, value: makeArchiveAllowedLifecycle() })
        : lifecycleRefresh.promise,
    });
    const { result } = renderHook(() => useController(gateway, {
      investigationId: makePopulatedCase().id,
      active: true,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    }));
    await waitFor(() => expect(result.current.lifecycle.status).toBe("ready"));

    act(() => {
      result.current.refreshEvidence();
      result.current.refreshLifecycle();
    });
    await waitFor(() => expect(result.current.evidence.status).toBe("loading"));
    const upload = makeEvidenceUploadSuccess();
    const publishedArtifact = { ...upload.artifact, filename: "published-while-loading.log" };
    const publishedSummary = { ...upload.summary, body: "Published while loading" };
    const publishedLifecycle = makeRestoreAllowedLifecycle();
    act(() => {
      result.current.publishEvidence(publishedArtifact, publishedSummary);
      result.current.publishLifecycle(publishedLifecycle);
    });

    expect(result.current.evidence).toEqual({
      status: "loading",
      previous: [publishedArtifact],
    });
    expect(result.current.lifecycle).toEqual({
      status: "loading",
      previous: publishedLifecycle,
    });

    await act(async () => {
      evidenceRefresh.resolve({ ok: false, error: { kind: "network" } });
      lifecycleRefresh.resolve({ ok: false, error: { kind: "unavailable", status: 503 } });
    });
    expect(result.current.evidence).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: [publishedArtifact],
    });
    expect(result.current.lifecycle).toEqual({
      status: "failed",
      error: { kind: "unavailable", status: 503 },
      previous: publishedLifecycle,
    });
  });

  it("ignores idle, mismatched, unlinked, and stale-scope publications", async () => {
    const { gateway, requests } = deferredReadGateway();
    const initialProps = {
      investigationId: "case-a",
      active: false,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    };
    const { result, rerender } = renderHook(
      (props) => useController(gateway, props),
      { initialProps },
    );
    const upload = makeEvidenceUploadSuccess();
    act(() => {
      result.current.publishInvestigation({ ...makePopulatedCase(), id: "case-a" });
      result.current.publishEvidence(
        { ...upload.artifact, caseId: "case-a" },
        { ...upload.summary, caseId: "case-a" },
      );
      result.current.publishLifecycle({
        ...makeArchiveAllowedLifecycle(),
        investigationId: "case-a",
      });
    });
    expect(result.current.investigation).toEqual({ status: "idle" });
    expect(result.current.evidence).toEqual({ status: "idle" });
    expect(result.current.lifecycle).toEqual({ status: "idle" });

    rerender({ ...initialProps, active: true });
    await waitFor(() => expect(requests.lifecycle).toHaveLength(1));
    const stalePublishCase = result.current.publishInvestigation;
    const stalePublishEvidence = result.current.publishEvidence;
    const stalePublishLifecycle = result.current.publishLifecycle;
    rerender({ ...initialProps, active: true, investigationId: "case-b" });
    await waitFor(() => expect(requests.lifecycle).toHaveLength(2));

    act(() => {
      stalePublishCase({ ...makePopulatedCase(), id: "case-a" });
      stalePublishEvidence(
        { ...upload.artifact, caseId: "case-a" },
        { ...upload.summary, caseId: "case-a" },
      );
      stalePublishLifecycle({
        ...makeArchiveAllowedLifecycle(),
        investigationId: "case-a",
      });
      result.current.publishInvestigation({ ...makePopulatedCase(), id: "case-a" });
      result.current.publishLifecycle({
        ...makeArchiveAllowedLifecycle(),
        investigationId: "case-a",
      });
      result.current.publishEvidence(
        { ...upload.artifact, caseId: "case-b", summaryContributionId: "different-summary" },
        { ...upload.summary, caseId: "case-b" },
      );
    });
    expect(result.current.investigation).toEqual({ status: "loading" });
    expect(result.current.evidence).toEqual({ status: "loading" });
    expect(result.current.contributions).toEqual({ status: "loading" });
    expect(result.current.lifecycle).toEqual({ status: "loading" });
  });

  it("contains one rejected lane without collapsing the other resources", async () => {
    const gateway = gatewayWith({
      getInvestigation: async () => ({ ok: true, value: makePopulatedCase() }),
      listEvidence: () => Promise.reject(new Error("private rejection")),
      listContributions: async () => ({ ok: true, value: [] }),
      getLifecycle: async () => ({ ok: true, value: makeArchiveAllowedLifecycle() }),
    });
    const { result } = renderHook(() => useController(gateway, {
      investigationId: makePopulatedCase().id,
      active: true,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    }));

    await waitFor(() => expect(result.current.evidence).toEqual({
      status: "failed",
      error: { kind: "unexpected" },
    }));
    expect(result.current.investigation.status).toBe("ready");
    expect(result.current.contributions).toEqual({ status: "ready", value: [] });
    expect(result.current.lifecycle.status).toBe("ready");
  });

  it("clears A immediately and rejects every late A lane after navigating to B", async () => {
    const { gateway, requests } = deferredReadGateway();
    const initialProps = {
      investigationId: "case-a",
      active: true,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    };
    const { result, rerender } = renderHook(
      (props) => useController(gateway, props),
      { initialProps },
    );
    await waitFor(() => expect(requests.lifecycle).toHaveLength(1));

    rerender({ ...initialProps, investigationId: "case-b" });
    await waitFor(() => expect(requests.lifecycle).toHaveLength(2));
    for (const lane of Object.values(requests)) {
      expect(lane[0]!.signal.aborted).toBe(true);
    }
    expect(result.current.investigation).toEqual({ status: "loading" });
    expect(result.current.evidence).toEqual({ status: "loading" });
    expect(result.current.contributions).toEqual({ status: "loading" });
    expect(result.current.lifecycle).toEqual({ status: "loading" });

    await act(async () => {
      requests.investigation[0]!.deferred.resolve({ ok: true, value: makePopulatedCase() });
      requests.evidence[0]!.deferred.resolve({ ok: true, value: makeEvidenceList().artifacts });
      requests.contributions[0]!.deferred.resolve({
        ok: true,
        value: makeContributionList().contributions,
      });
      requests.lifecycle[0]!.deferred.resolve({
        ok: true,
        value: makeArchiveAllowedLifecycle(),
      });
    });
    expect(result.current.investigation).toEqual({ status: "loading" });
    expect(result.current.evidence).toEqual({ status: "loading" });

    const caseB = { ...makeSparseImportedCase(), id: "case-b" };
    const lifecycleB = {
      ...makeArchiveAllowedLifecycle(),
      investigationId: "case-b",
    };
    await act(async () => {
      requests.investigation[1]!.deferred.resolve({ ok: true, value: caseB });
      requests.evidence[1]!.deferred.resolve({ ok: true, value: [] });
      requests.contributions[1]!.deferred.resolve({ ok: true, value: [] });
      requests.lifecycle[1]!.deferred.resolve({ ok: true, value: lifecycleB });
    });
    expect(result.current.investigation).toEqual({ status: "ready", value: caseB });
    expect(result.current.evidence).toEqual({ status: "ready", value: [] });
    expect(result.current.contributions).toEqual({ status: "ready", value: [] });
    expect(result.current.lifecycle).toEqual({ status: "ready", value: lifecycleB });
  });

  it("reports evidence and contribution outcomes independently", async () => {
    const gateway = gatewayWith({
      getInvestigation: async () => ({ ok: true, value: makePopulatedCase() }),
      listEvidence: async () => ({ ok: false, error: { kind: "network" } }),
      listContributions: async () => ({
        ok: true,
        value: makeContributionList().contributions,
      }),
      getLifecycle: async () => ({
        ok: false,
        error: { kind: "unavailable", status: 503 },
      }),
    });
    const { result } = renderHook(() => useController(gateway, {
      investigationId: makePopulatedCase().id,
      active: true,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    }));

    await waitFor(() => expect(result.current.lifecycle.status).toBe("failed"));
    expect(result.current.investigation.status).toBe("ready");
    expect(result.current.evidence).toEqual({
      status: "failed",
      error: { kind: "network" },
    });
    expect(result.current.contributions).toEqual({
      status: "ready",
      value: makeContributionList().contributions,
    });
    expect(result.current.lifecycle).toEqual({
      status: "failed",
      error: { kind: "unavailable", status: 503 },
    });
  });

  it("retains only same-scope previous data during an individual refresh", async () => {
    const refresh = createDeferred<GatewayResult<CaseV1>>();
    let investigationReads = 0;
    const gateway = gatewayWith({
      getInvestigation: () => {
        investigationReads += 1;
        return investigationReads === 1
          ? Promise.resolve({ ok: true, value: makePopulatedCase() })
          : refresh.promise;
      },
      listEvidence: async () => ({ ok: true, value: [] }),
      listContributions: async () => ({ ok: true, value: [] }),
      getLifecycle: async () => ({ ok: true, value: makeArchiveAllowedLifecycle() }),
    });
    const { result } = renderHook(() => useController(gateway, {
      investigationId: makePopulatedCase().id,
      active: true,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    }));
    await waitFor(() => expect(result.current.investigation.status).toBe("ready"));

    act(() => result.current.refreshInvestigation());
    expect(result.current.investigation).toEqual({
      status: "loading",
      previous: makePopulatedCase(),
    });
    expect(result.current.evidence).toEqual({ status: "ready", value: [] });
    await act(async () => {
      refresh.resolve({ ok: false, error: { kind: "network" } });
    });
    expect(result.current.investigation).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: makePopulatedCase(),
    });
  });

  it.each(["identityKey", "authorityKey"] as const)(
    "aborts and clears every lane when %s changes",
    async (changedKey) => {
      const { gateway, requests } = deferredReadGateway();
      const initialProps = {
        investigationId: "case-a",
        active: true,
        identityKey: "alice",
        authorityKey: "interactive:lead",
      };
      const { result, rerender } = renderHook(
        (props) => useController(gateway, props),
        { initialProps },
      );
      await waitFor(() => expect(requests.lifecycle).toHaveLength(1));

      rerender({
        ...initialProps,
        [changedKey]: changedKey === "identityKey" ? "bob" : "static:lead",
      });
      await waitFor(() => expect(requests.lifecycle).toHaveLength(2));
      for (const lane of Object.values(requests)) {
        expect(lane[0]!.signal.aborted).toBe(true);
      }
      expect(result.current.investigation).toEqual({ status: "loading" });
      expect(result.current.evidence).toEqual({ status: "loading" });
      expect(result.current.contributions).toEqual({ status: "loading" });
      expect(result.current.lifecycle).toEqual({ status: "loading" });
    },
  );

  it("aborts every pending lane and ignores late completion when the active case is left", async () => {
    const { gateway, requests } = deferredReadGateway();
    const initialProps = {
      investigationId: "case-a",
      active: true,
      identityKey: "alice",
      authorityKey: "interactive:lead",
    };
    const { result, rerender } = renderHook(
      (props) => useController(gateway, props),
      { initialProps },
    );
    await waitFor(() => expect(requests.lifecycle).toHaveLength(1));

    rerender({ ...initialProps, active: false });
    for (const lane of Object.values(requests)) {
      expect(lane[0]!.signal.aborted).toBe(true);
    }
    expect(result.current.investigation).toEqual({ status: "idle" });
    expect(result.current.evidence).toEqual({ status: "idle" });
    expect(result.current.contributions).toEqual({ status: "idle" });
    expect(result.current.lifecycle).toEqual({ status: "idle" });

    await act(async () => {
      requests.investigation[0]!.deferred.resolve({ ok: true, value: makePopulatedCase() });
      requests.evidence[0]!.deferred.resolve({ ok: true, value: makeEvidenceList().artifacts });
      requests.contributions[0]!.deferred.resolve({
        ok: true,
        value: makeContributionList().contributions,
      });
      requests.lifecycle[0]!.deferred.resolve({
        ok: true,
        value: makeArchiveAllowedLifecycle(),
      });
    });
    expect(result.current.investigation).toEqual({ status: "idle" });
    expect(result.current.evidence).toEqual({ status: "idle" });
    expect(result.current.contributions).toEqual({ status: "idle" });
    expect(result.current.lifecycle).toEqual({ status: "idle" });
  });

  it("resets active data outside investigations while the list remains published", async () => {
    const gateway = gatewayWith({
      listInvestigations: async () => ({ ok: true, value: makeCaseList().cases }),
      getInvestigation: async () => ({ ok: true, value: makePopulatedCase() }),
      listEvidence: async () => ({ ok: true, value: makeEvidenceList().artifacts }),
      listContributions: async () => ({
        ok: true,
        value: makeContributionList().contributions,
      }),
      getLifecycle: async () => ({ ok: true, value: makeArchiveAllowedLifecycle() }),
    });
    const { result, rerender } = renderHook(
      ({ active }) => ({
        list: useInvestigationList({
          gateway,
          enabled: true,
          identityKey: "alice",
          authorityKey: "interactive:lead",
        }),
        active: useController(gateway, {
          investigationId: makePopulatedCase().id,
          active,
          identityKey: "alice",
          authorityKey: "interactive:lead",
        }),
      }),
      { initialProps: { active: true } },
    );
    await waitFor(() => expect(result.current.active.lifecycle.status).toBe("ready"));
    expect(result.current.list.investigations.status).toBe("ready");

    rerender({ active: false });
    expect(result.current.list.investigations.status).toBe("ready");
    expect(result.current.active.investigation).toEqual({ status: "idle" });
    expect(result.current.active.evidence).toEqual({ status: "idle" });
    expect(result.current.active.contributions).toEqual({ status: "idle" });
    expect(result.current.active.lifecycle).toEqual({ status: "idle" });
  });
});
