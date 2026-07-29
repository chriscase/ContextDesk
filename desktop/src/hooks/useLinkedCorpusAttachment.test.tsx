import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, sessionToDto, type ChatSession } from "../lib/session";
import { useLinkedCorpusAttachment } from "./useLinkedCorpusAttachment";

const host = vi.hoisted(() => ({
  setLinkedCorpus: vi.fn(),
}));

vi.mock("../lib/host", () => ({
  hostSetChatLinkedCorpus: host.setLinkedCorpus,
}));

function fixture(): ChatSession {
  return {
    ...newSession("Incident review", null),
    id: "session-1",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

describe("useLinkedCorpusAttachment governed mutation", () => {
  beforeEach(() => {
    host.setLinkedCorpus.mockReset();
  });

  it("waits for host validation before advertising attached context", async () => {
    const session = fixture();
    const response = deferred<ReturnType<typeof sessionToDto>>();
    host.setLinkedCorpus.mockReturnValue(response.promise);
    const { result } = renderHook(() => {
      const [sessions, setSessions] = useState([session]);
      const attachment = useLinkedCorpusAttachment({
        ensureActiveSession: () => session,
        setSessions,
      });
      return { ...attachment, sessions };
    });

    let mutation!: Promise<void>;
    act(() => {
      mutation = result.current.setSessionLinkedCorpus("corpus-a");
    });
    expect(result.current.sessions[0]?.linkedCorpusId).toBeNull();
    expect(result.current.pendingSessionIds.has(session.id)).toBe(true);
    expect(host.setLinkedCorpus).toHaveBeenCalledWith(
      session.id,
      "corpus-a",
      sessionToDto(session),
      session.updatedAt,
    );

    response.resolve({
      ...sessionToDto(session),
      linked_corpus_id: "corpus-a",
      updated_at: "2026-07-28T12:00:01.000Z",
    });
    await act(async () => mutation);
    expect(result.current.sessions[0]?.linkedCorpusId).toBe("corpus-a");
    expect(result.current.pendingSessionIds.has(session.id)).toBe(false);
  });

  it("leaves visible context unchanged when host validation fails", async () => {
    const session = fixture();
    host.setLinkedCorpus.mockRejectedValue(new Error("corpus unavailable"));
    const { result } = renderHook(() => {
      const [sessions, setSessions] = useState([session]);
      const attachment = useLinkedCorpusAttachment({
        ensureActiveSession: () => session,
        setSessions,
      });
      return { ...attachment, sessions };
    });

    await expect(
      act(async () => result.current.setSessionLinkedCorpus("missing")),
    ).rejects.toThrow("corpus unavailable");
    expect(result.current.sessions[0]?.linkedCorpusId).toBeNull();
    expect(result.current.pendingSessionIds.has(session.id)).toBe(false);
  });

  it("rejects a second same-chat mutation while the first is unresolved", async () => {
    const session = fixture();
    const response = deferred<ReturnType<typeof sessionToDto>>();
    host.setLinkedCorpus.mockReturnValue(response.promise);
    const { result } = renderHook(() => {
      const [sessions, setSessions] = useState([session]);
      const attachment = useLinkedCorpusAttachment({
        ensureActiveSession: () => session,
        setSessions,
      });
      return { ...attachment, sessions };
    });

    let first!: Promise<void>;
    act(() => {
      first = result.current.setSessionLinkedCorpus("corpus-a");
    });
    await expect(
      result.current.setSessionLinkedCorpus(null),
    ).rejects.toThrow("already being updated");
    expect(host.setLinkedCorpus).toHaveBeenCalledTimes(1);

    response.resolve({
      ...sessionToDto(session),
      linked_corpus_id: "corpus-a",
    });
    await act(async () => first);
    await waitFor(() =>
      expect(result.current.pendingSessionIds.has(session.id)).toBe(false),
    );
  });
});
