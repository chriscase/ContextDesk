import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_ANNOTATION_SCHEMA_ID,
  type ArtifactAnnotationV1,
} from "../annotation-contract.js";
import type {
  CreateArtifactAnnotationInput,
  GatewayResult,
  InvestigationAnnotationGateway,
} from "../gateway.js";
import { RUNTIME_FIXTURE_IDS } from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useArtifactAnnotations,
  useCreateArtifactAnnotation,
  type UseArtifactAnnotationsOptions,
  type UseCreateArtifactAnnotationOptions,
} from "./use-artifact-annotations.js";

afterEach(() => cleanup());

function annotation(overrides: Partial<ArtifactAnnotationV1> = {}): ArtifactAnnotationV1 {
  return {
    schemaId: ARTIFACT_ANNOTATION_SCHEMA_ID,
    id: "annotation-001",
    caseId: RUNTIME_FIXTURE_IDS.populatedCase,
    artifactId: RUNTIME_FIXTURE_IDS.evidence,
    body: "The first error appears after the configuration reload.",
    contentHash: "a".repeat(64),
    privacyClass: "share_safe",
    authorId: "identity-lead",
    authorUsername: "lead",
    createdAt: "2026-02-03T20:20:00.000Z",
    sourceId: "source-human-note",
    ...overrides,
  };
}

const unavailable = async <T,>(): Promise<GatewayResult<T>> => ({
  ok: false,
  error: { kind: "unavailable", status: 503 },
});

function annotationGateway(
  overrides: Partial<InvestigationAnnotationGateway> = {},
): InvestigationAnnotationGateway {
  return {
    listArtifactAnnotations: vi.fn(async () => ({
      ok: true as const,
      value: [annotation()],
    })),
    createArtifactAnnotation: vi.fn(async (
      caseId: string,
      artifactId: string,
      input: CreateArtifactAnnotationInput,
    ) => ({
      ok: true as const,
      value: annotation({ caseId, artifactId, body: input.body }),
    })),
    ...overrides,
  };
}

function readOptions(
  overrides: Partial<UseArtifactAnnotationsOptions> = {},
): UseArtifactAnnotationsOptions {
  return {
    gateway: annotationGateway(),
    identityKey: "alice",
    authorityKey: "alice-authority-v1",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    active: true,
    canRead: true,
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

function createOptions(
  overrides: Partial<UseCreateArtifactAnnotationOptions> = {},
): UseCreateArtifactAnnotationOptions {
  return {
    gateway: annotationGateway(),
    identityKey: "alice",
    authorityKey: "alice-authority-v1",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    canAnnotate: true,
    readOnly: false,
    onCreated: vi.fn(),
    onRefresh: vi.fn(),
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

describe("useArtifactAnnotations", () => {
  it("loads the active case and publishes the authoritative collection", async () => {
    const gateway = annotationGateway();
    const opts = readOptions({ gateway });
    const { result } = renderHook(() => useArtifactAnnotations(opts));

    await waitFor(() => expect(result.current.annotations).toEqual({
      status: "ready",
      value: [annotation()],
    }));
    expect(gateway.listArtifactAnnotations).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("resolves a refresh only after the authoritative response settles", async () => {
    const refreshed = createDeferred<GatewayResult<readonly ArtifactAnnotationV1[]>>();
    let calls = 0;
    const gateway = annotationGateway({
      listArtifactAnnotations: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ ok: true as const, value: [annotation()] })
          : refreshed.promise;
      }),
    });
    const { result } = renderHook(() => useArtifactAnnotations(readOptions({ gateway })));
    await waitFor(() => expect(result.current.annotations.status).toBe("ready"));

    let settled = false;
    const pending = result.current.refresh().then(() => { settled = true; });
    await act(async () => undefined);
    expect(settled).toBe(false);
    refreshed.resolve({ ok: true, value: [annotation({ id: "annotation-refreshed" })] });
    await pending;
    expect(settled).toBe(true);
    await waitFor(() => expect(result.current.annotations).toMatchObject({
      status: "ready",
      value: [{ id: "annotation-refreshed" }],
    }));
  });

  it.each([
    ["inactive", { active: false }],
    ["read denied", { canRead: false }],
    ["without a case", { investigationId: null }],
  ] as const)("does not read when the scope is %s", async (_label, change) => {
    const listArtifactAnnotations = vi.fn();
    const gateway = annotationGateway({ listArtifactAnnotations });
    const opts = readOptions({ gateway, ...change });
    const { result } = renderHook(() => useArtifactAnnotations(opts));

    await act(async () => undefined);
    expect(result.current.annotations).toEqual({ status: "idle" });
    expect(listArtifactAnnotations).not.toHaveBeenCalled();
  });

  it("aborts and suppresses a late case A collection after moving to case B", async () => {
    const first = createDeferred<GatewayResult<readonly ArtifactAnnotationV1[]>>();
    const second = createDeferred<GatewayResult<readonly ArtifactAnnotationV1[]>>();
    const signals: AbortSignal[] = [];
    const gateway = annotationGateway({
      listArtifactAnnotations: vi.fn((_caseId, { signal }) => {
        signals.push(signal);
        return signals.length === 1 ? first.promise : second.promise;
      }),
    });
    const initial = readOptions({ gateway });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseArtifactAnnotationsOptions }) => useArtifactAnnotations(value),
      { initialProps: { value: initial } },
    );
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender({ value: { ...initial, investigationId: "case-b" } });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => {
      first.resolve({ ok: true, value: [annotation()] });
      await Promise.resolve();
    });
    expect(result.current.annotations).toEqual({ status: "loading" });
    second.resolve({ ok: true, value: [annotation({ caseId: "case-b" })] });
    await waitFor(() => expect(result.current.annotations.status).toBe("ready"));
    if (result.current.annotations.status !== "ready") throw new Error("expected ready");
    expect(result.current.annotations.value[0]?.caseId).toBe("case-b");
  });

  it("denies the case on a bounded access failure", async () => {
    const onScopeDenied = vi.fn();
    const gateway = annotationGateway({
      listArtifactAnnotations: vi.fn(async (): Promise<GatewayResult<readonly ArtifactAnnotationV1[]>> => ({
        ok: false as const,
        error: { kind: "auth_lost" as const, status: 403 },
      })),
    });
    const { result } = renderHook(() => useArtifactAnnotations(
      readOptions({ gateway, onScopeDenied }),
    ));

    await waitFor(() => expect(result.current.annotations.status).toBe("failed"));
    expect(onScopeDenied).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "auth_lost", status: 403 },
    );
  });

  it("publishes a confirmed annotation only for the active case", async () => {
    const gateway = annotationGateway();
    const { result } = renderHook(() => useArtifactAnnotations(readOptions({ gateway })));
    await waitFor(() => expect(result.current.annotations.status).toBe("ready"));

    act(() => result.current.publish(annotation({ id: "annotation-created" })));
    expect(result.current.annotations).toMatchObject({
      status: "ready",
      value: [{ id: "annotation-001" }, { id: "annotation-created" }],
    });
    act(() => result.current.publish(annotation({ id: "wrong-case", caseId: "case-other" })));
    expect(result.current.annotations).not.toMatchObject({
      value: expect.arrayContaining([{ id: "wrong-case" }]),
    });
  });

  it("fails closed when the annotation gateway is unavailable", async () => {
    const opts = readOptions({
      gateway: {
        listArtifactAnnotations: unavailable,
        createArtifactAnnotation: unavailable,
      },
    });
    const { result } = renderHook(() => useArtifactAnnotations(opts));

    await waitFor(() => expect(result.current.annotations).toEqual({
      status: "failed",
      error: { kind: "unavailable", status: 503 },
    }));
  });
});

describe("useCreateArtifactAnnotation", () => {
  it("publishes the server annotation and refreshes the same case", async () => {
    const created = annotation({ id: "annotation-created", body: "A useful file note." });
    const createArtifactAnnotation = vi.fn(async () => ({ ok: true as const, value: created }));
    const opts = createOptions({
      gateway: annotationGateway({ createArtifactAnnotation }),
    });
    const { result } = renderHook(() => useCreateArtifactAnnotation(opts));

    await act(async () => {
      await expect(result.current.create({
        artifactId: RUNTIME_FIXTURE_IDS.evidence,
        body: "A useful file note.",
        privacyClass: "owner_only",
        clientTime: "2026-02-03T20:21:00.000Z",
        sourceId: "source-human-note",
      })).resolves.toEqual({ status: "succeeded", value: created });
    });
    expect(createArtifactAnnotation).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      RUNTIME_FIXTURE_IDS.evidence,
      {
        body: "A useful file note.",
        privacyClass: "owner_only",
        clientTime: "2026-02-03T20:21:00.000Z",
        sourceId: "source-human-note",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(opts.onCreated).toHaveBeenCalledWith(created);
    expect(opts.onRefresh).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
    expect(result.current.state).toEqual({ status: "succeeded", value: created });
  });

  it("does not write without annotation authority or outside read-only mode", async () => {
    const createArtifactAnnotation = vi.fn();
    const base = createOptions({
      gateway: annotationGateway({ createArtifactAnnotation }),
      canAnnotate: false,
    });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateArtifactAnnotationOptions }) => useCreateArtifactAnnotation(value),
      { initialProps: { value: base } },
    );

    await expect(result.current.create({
      artifactId: RUNTIME_FIXTURE_IDS.evidence,
      body: "Not allowed.",
    })).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    rerender({ value: { ...base, canAnnotate: true, readOnly: true } });
    await expect(result.current.create({
      artifactId: RUNTIME_FIXTURE_IDS.evidence,
      body: "Still not allowed.",
    })).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    expect(createArtifactAnnotation).not.toHaveBeenCalled();
  });

  it("suppresses a late completion after the identity or case scope changes", async () => {
    const deferred = createDeferred<GatewayResult<ArtifactAnnotationV1>>();
    const createArtifactAnnotation = vi.fn(() => deferred.promise);
    const initial = createOptions({
      gateway: annotationGateway({ createArtifactAnnotation }),
    });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateArtifactAnnotationOptions }) => useCreateArtifactAnnotation(value),
      { initialProps: { value: initial } },
    );
    let pending!: ReturnType<typeof result.current.create>;
    await act(async () => {
      pending = result.current.create({
        artifactId: RUNTIME_FIXTURE_IDS.evidence,
        body: "Late annotation.",
      });
      await Promise.resolve();
    });
    rerender({ value: { ...initial, investigationId: "case-b" } });
    expect(result.current.state).toEqual({ status: "idle" });

    await act(async () => {
      deferred.resolve({ ok: true, value: annotation({ id: "late" }) });
      await expect(pending).resolves.toEqual({ status: "ignored", reason: "stale" });
    });
    expect(initial.onCreated).not.toHaveBeenCalled();
    expect(initial.onRefresh).not.toHaveBeenCalled();
  });

  it("rejects an annotation answered for another case or artifact", async () => {
    const createArtifactAnnotation = vi.fn(async (): Promise<GatewayResult<ArtifactAnnotationV1>> => ({
      ok: true as const,
      value: annotation({ caseId: "case-other" }),
    }));
    const opts = createOptions({
      gateway: annotationGateway({ createArtifactAnnotation }),
    });
    const { result } = renderHook(() => useCreateArtifactAnnotation(opts));

    await act(async () => {
      await expect(result.current.create({
        artifactId: RUNTIME_FIXTURE_IDS.evidence,
        body: "Mismatched.",
      })).resolves.toEqual({
        status: "failed",
        error: { kind: "protocol", reason: "identity" },
      });
    });
    expect(opts.onCreated).not.toHaveBeenCalled();
  });

  it("denies the scope on a bounded auth failure", async () => {
    const onScopeDenied = vi.fn();
    const createArtifactAnnotation: InvestigationAnnotationGateway["createArtifactAnnotation"] = vi.fn(async (
      _caseId,
      _artifactId,
      _input,
      _options,
    ): Promise<GatewayResult<ArtifactAnnotationV1>> => ({
      ok: false as const,
      error: { kind: "auth_lost", status: 401 },
    }));
    const opts = createOptions({
      gateway: annotationGateway({ createArtifactAnnotation }),
      onScopeDenied,
    });
    const { result } = renderHook(() => useCreateArtifactAnnotation(opts));

    await act(async () => {
      await expect(result.current.create({
        artifactId: RUNTIME_FIXTURE_IDS.evidence,
        body: "Denied.",
      })).resolves.toEqual({
        status: "failed",
        error: { kind: "auth_lost", status: 401 },
      });
    });
    expect(onScopeDenied).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "auth_lost", status: 401 },
    );
  });

  it("contains hostile command getters before starting a write", async () => {
    const createArtifactAnnotation = vi.fn();
    const opts = createOptions({
      gateway: annotationGateway({ createArtifactAnnotation }),
    });
    const { result } = renderHook(() => useCreateArtifactAnnotation(opts));
    const command = {} as Record<string, unknown>;
    Object.defineProperty(command, "artifactId", {
      get: () => {
        throw new Error("private command detail");
      },
    });

    await expect(result.current.create(command as never)).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(createArtifactAnnotation).not.toHaveBeenCalled();
  });
});
