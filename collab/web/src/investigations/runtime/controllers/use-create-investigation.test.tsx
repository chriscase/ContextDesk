import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvestigationGateway } from "../gateway.js";
import { makePopulatedCase } from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useCreateInvestigation,
  type UseCreateInvestigationOptions,
} from "./use-create-investigation.js";

afterEach(() => cleanup());

function gatewayWithCreate(
  createInvestigation: InvestigationGateway["createInvestigation"],
): InvestigationGateway {
  return { createInvestigation } as InvestigationGateway;
}

function options(
  overrides: Partial<UseCreateInvestigationOptions> = {},
): UseCreateInvestigationOptions {
  return {
    gateway: gatewayWithCreate(vi.fn()),
    identityKey: "alice",
    authorityKey: "lead-v1",
    canCreate: true,
    readOnly: false,
    isInvestigationLocation: true,
    locationInvestigationId: null,
    onCreated: vi.fn(),
    onOpenCreated: vi.fn(),
    ...overrides,
  };
}

describe("useCreateInvestigation", () => {
  it("remains usable after StrictMode replays effect cleanup and setup", async () => {
    const created = makePopulatedCase();
    const createInvestigation = vi.fn(async () => ({ ok: true as const, value: created }));
    const opts = options({ gateway: gatewayWithCreate(createInvestigation) });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(() => useCreateInvestigation(opts), { wrapper });

    await act(async () => {
      await expect(result.current.create({ title: "Strict mode" })).resolves.toEqual({
        status: "succeeded",
        value: created,
      });
    });
    expect(opts.onCreated).toHaveBeenCalledWith(created);
  });

  it("trims the title, publishes the authoritative case, and opens it from the origin", async () => {
    const created = makePopulatedCase();
    const createInvestigation = vi.fn(async () => ({ ok: true as const, value: created }));
    const opts = options({ gateway: gatewayWithCreate(createInvestigation) });
    const { result } = renderHook(() => useCreateInvestigation(opts));

    let outcome;
    await act(async () => {
      outcome = await result.current.create({ title: "  Checkout latency  ", severity: "high" });
    });

    expect(outcome).toEqual({ status: "succeeded", value: created });
    expect(createInvestigation).toHaveBeenCalledWith(
      { title: "Checkout latency", severity: "high" },
      { signal: expect.any(AbortSignal) },
    );
    expect(opts.onCreated).toHaveBeenCalledWith(created);
    expect(opts.onOpenCreated).toHaveBeenCalledWith(created.id);
    expect(result.current.state).toEqual({ status: "succeeded", value: created });
  });

  it("fails closed for authorization/read-only and bounds a missing title", async () => {
    const createInvestigation = vi.fn();
    const denied = options({
      gateway: gatewayWithCreate(createInvestigation),
      canCreate: false,
    });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateInvestigationOptions }) => useCreateInvestigation(value),
      { initialProps: { value: denied } },
    );

    await expect(result.current.create({ title: "Denied" })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({ value: options({ gateway: denied.gateway, readOnly: true }) });
    await expect(result.current.create({ title: "Read only" })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({ value: options({ gateway: denied.gateway }) });
    await act(async () => {
      await expect(result.current.create({ title: "   " })).resolves.toEqual({
        status: "failed",
        error: { kind: "input", field: "title", reason: "required" },
      });
    });
    expect(createInvestigation).not.toHaveBeenCalled();
  });

  it.each([
    { label: "after leaving investigations", location: false, investigationId: null },
    { label: "after opening a detail", location: true, investigationId: "case-detail" },
  ])("rejects a retained create callback $label", async ({ location, investigationId }) => {
    const createInvestigation = vi.fn();
    const first = options({ gateway: gatewayWithCreate(createInvestigation) });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateInvestigationOptions }) => useCreateInvestigation(value),
      { initialProps: { value: first } },
    );
    const retainedCreate = result.current.create;

    rerender({
      value: {
        ...first,
        isInvestigationLocation: location,
        locationInvestigationId: investigationId,
      },
    });

    await expect(retainedCreate({ title: "Stale surface" })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(createInvestigation).not.toHaveBeenCalled();
  });

  it("allows only one in-flight create", async () => {
    const deferred = createDeferred<Awaited<ReturnType<InvestigationGateway["createInvestigation"]>>>();
    const gateway = gatewayWithCreate(vi.fn(() => deferred.promise));
    const { result } = renderHook(() => useCreateInvestigation(options({ gateway })));

    let first!: ReturnType<typeof result.current.create>;
    act(() => {
      first = result.current.create({ title: "First" });
    });
    await expect(result.current.create({ title: "Second" })).resolves.toEqual({
      status: "ignored",
      reason: "busy",
    });
    await act(async () => {
      deferred.resolve({ ok: true, value: makePopulatedCase() });
      await first;
    });
  });

  it("aborts and suppresses all publication when identity changes", async () => {
    const deferred = createDeferred<Awaited<ReturnType<InvestigationGateway["createInvestigation"]>>>();
    let observedSignal: AbortSignal | undefined;
    const gateway = gatewayWithCreate(vi.fn((_input, request) => {
      observedSignal = request.signal;
      return deferred.promise;
    }));
    const first = options({ gateway });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateInvestigationOptions }) => useCreateInvestigation(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.create>;
    act(() => {
      pending = result.current.create({ title: "Pending" });
    });
    rerender({ value: { ...first, identityKey: "bob" } });
    expect(observedSignal?.aborted).toBe(true);

    let outcome;
    await act(async () => {
      deferred.resolve({ ok: true, value: makePopulatedCase() });
      outcome = await pending;
    });
    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(first.onCreated).not.toHaveBeenCalled();
    expect(first.onOpenCreated).not.toHaveBeenCalled();
  });

  it("hides completed and failed state during the first render of a new identity or authority", async () => {
    const created = makePopulatedCase();
    const gateway = gatewayWithCreate(vi.fn(async () => ({ ok: true as const, value: created })));
    const first = options({ gateway });
    const renderedStates: Array<ReturnType<typeof useCreateInvestigation>["state"]> = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateInvestigationOptions }) => {
        const controller = useCreateInvestigation(value);
        renderedStates.push(controller.state);
        return controller;
      },
      { initialProps: { value: first } },
    );

    await act(async () => {
      await result.current.create({ title: "Created by Alice" });
    });
    expect(result.current.state).toEqual({ status: "succeeded", value: created });

    renderedStates.length = 0;
    rerender({ value: { ...first, identityKey: "bob" } });
    expect(renderedStates[0]).toEqual({ status: "idle" });
    expect(result.current.state).toEqual({ status: "idle" });

    await act(async () => {
      await result.current.create({ title: "   " });
    });
    expect(result.current.state).toEqual({
      status: "failed",
      error: { kind: "input", field: "title", reason: "required" },
    });

    renderedStates.length = 0;
    rerender({ value: { ...first, identityKey: "bob", authorityKey: "lead-v2" } });
    expect(renderedStates[0]).toEqual({ status: "idle" });
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("publishes a late create but does not hijack navigation after the user leaves", async () => {
    const deferred = createDeferred<Awaited<ReturnType<InvestigationGateway["createInvestigation"]>>>();
    const gateway = gatewayWithCreate(vi.fn(() => deferred.promise));
    const first = options({ gateway });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateInvestigationOptions }) => useCreateInvestigation(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.create>;
    act(() => {
      pending = result.current.create({ title: "No hijack" });
    });
    rerender({ value: { ...first, isInvestigationLocation: false } });
    await act(async () => {
      deferred.resolve({ ok: true, value: makePopulatedCase() });
      await pending;
    });

    expect(first.onCreated).toHaveBeenCalledOnce();
    expect(first.onOpenCreated).not.toHaveBeenCalled();
  });

  it("aborts on unmount and treats an abort-ignoring completion as stale", async () => {
    const deferred = createDeferred<Awaited<ReturnType<InvestigationGateway["createInvestigation"]>>>();
    let observedSignal: AbortSignal | undefined;
    const gateway = gatewayWithCreate(vi.fn((_input, request) => {
      observedSignal = request.signal;
      return deferred.promise;
    }));
    const opts = options({ gateway });
    const { result, unmount } = renderHook(() => useCreateInvestigation(opts));

    let pending!: ReturnType<typeof result.current.create>;
    act(() => {
      pending = result.current.create({ title: "Unmounted" });
    });
    unmount();
    expect(observedSignal?.aborted).toBe(true);
    deferred.resolve({ ok: true, value: makePopulatedCase() });

    await expect(pending).resolves.toEqual({ status: "ignored", reason: "stale" });
    expect(opts.onCreated).not.toHaveBeenCalled();
    expect(opts.onOpenCreated).not.toHaveBeenCalled();
  });
});
