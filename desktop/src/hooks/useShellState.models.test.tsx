import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOptionDto } from "../lib/host";
import { useShellState } from "./useShellState";

const host = vi.hoisted(() => ({
  listModels: vi.fn(),
  defaultModel: vi.fn(),
}));

vi.mock("../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/host")>();
  return {
    ...original,
    hostListChatModels: host.listModels,
    hostGetDefaultChatModel: host.defaultModel,
  };
});

function model(toolsEnabled: boolean): ModelOptionDto {
  return {
    id: "model-a",
    label: "Model A",
    selection_key: "provider-a::model-a",
    provider_id: "provider-a",
    provider_label: "Provider A",
    group: "Provider A",
    is_default: true,
    tools_enabled: toolsEnabled,
    tools_disabled_reason: toolsEnabled ? null : "model",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
  host.defaultModel.mockResolvedValue("provider-a::model-a");
});

describe("model capability refresh ordering", () => {
  it("does not let an older list response launder newer rejection truth", async () => {
    const older = deferred<ModelOptionDto[]>();
    const newer = deferred<ModelOptionDto[]>();
    host.listModels
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
      .mockResolvedValue([model(false)]);
    const { result } = renderHook(() => useShellState());
    await waitFor(() => expect(host.listModels.mock.calls.length).toBeGreaterThanOrEqual(2));

    await act(async () => newer.resolve([model(false)]));
    await waitFor(() => expect(result.current.modelOptions[0]?.tools_enabled).toBe(false));
    await act(async () => older.resolve([model(true)]));

    expect(result.current.modelOptions[0]?.tools_enabled).toBe(false);
  });
});
