import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionDto, SessionMetaDto } from "../lib/host";
import { newSession, sessionToDto, type ChatSession } from "../lib/session";
import { useChatSessions } from "./useChatSessions";

const host = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/host")>();
  return {
    ...original,
    hostListChatSessions: host.list,
    hostLoadChatSession: host.load,
    hostSaveChatSession: host.save,
  };
});

function dto(id: string, title = id): ChatSessionDto {
  return sessionToDto({ ...newSession(title), id });
}

function meta(session: ChatSessionDto): SessionMetaDto {
  return {
    id: session.id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    archived: session.archived,
    trashed: session.trashed ?? false,
    pinned: session.pinned,
    message_count: session.messages.length,
  } as SessionMetaDto;
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
});

describe("session hydration and persistence races", () => {
  it("does not erase a first send created before hydration resolves", async () => {
    const listing = deferred<SessionMetaDto[]>();
    host.list.mockReturnValueOnce(listing.promise);
    const { result } = renderHook(() => useChatSessions());

    act(() => {
      const created = result.current.ensureActiveSession();
      result.current.setSessions((all) =>
        all.map((session) =>
          session.id === created.id
            ? {
                ...session,
                messages: [{ id: "u1", role: "user", content: "first send" }],
              }
            : session,
        ),
      );
    });
    await act(async () => listing.resolve([]));
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    expect(result.current.sessions[0]?.messages[0]?.content).toBe("first send");
  });

  it("does not apply a saved snapshot after the local session advanced", async () => {
    const initial = dto("s1");
    host.list.mockResolvedValueOnce([meta(initial)]);
    host.load.mockResolvedValueOnce(initial);
    const saving = deferred<ChatSessionDto>();
    host.save.mockReturnValueOnce(saving.promise);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));

    let pending!: Promise<ChatSession>;
    let submitted!: ChatSession;
    act(() => {
      submitted = {
        ...result.current.sessions[0]!,
        messages: [{ id: "u1", role: "user", content: "turn one" }],
        updatedAt: "2026-07-31T10:00:00.000Z",
      };
      result.current.setSessions([submitted]);
      pending = result.current.persistSession(submitted);
    });
    act(() => {
      result.current.setSessions((all) => [
        {
          ...all[0]!,
          messages: [
            ...all[0]!.messages,
            { id: "u2", role: "user", content: "turn two" },
          ],
          updatedAt: "2026-07-31T10:00:01.000Z",
        },
      ]);
    });
    await act(async () => {
      saving.resolve(sessionToDto(submitted));
      await pending;
    });

    expect(result.current.sessions[0]!.messages.map((message) => message.content)).toEqual([
      "turn one",
      "turn two",
    ]);
    expect(host.save).toHaveBeenCalledWith(
      expect.any(Object),
      initial.updated_at,
    );
  });

  it("reconciles only the latest mutation after a host CAS conflict", async () => {
    const initial = dto("s-cas");
    host.list.mockResolvedValueOnce([meta(initial)]);
    host.load.mockResolvedValueOnce(initial);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));

    const pending: ChatSession = {
      ...result.current.sessions[0]!,
      messages: [{ id: "local", role: "user", content: "local turn" }],
      updatedAt: "2026-07-31T10:00:00.000Z",
    };
    const durableDto = dto("s-cas");
    durableDto.updated_at = "2026-07-31T10:00:01.000Z";
    durableDto.messages = [
      { id: "host", role: "assistant", content: "host terminal" },
    ];
    host.save
      .mockRejectedValueOnce(new Error("chat_session_conflict: changed"))
      .mockImplementationOnce(async (merged: ChatSessionDto) => merged);
    host.load.mockResolvedValueOnce(durableDto);

    await act(async () => {
      result.current.setSessions([pending]);
      await result.current.persistSession(pending);
    });

    const [merged, expectedRevision] = host.save.mock.calls[1]!;
    expect(expectedRevision).toBe(durableDto.updated_at);
    expect(
      (merged as ChatSessionDto).messages.map((message) => message.id),
    ).toEqual(["host", "local"]);
  });

  it("discards an older host sync that resolves after a newer one", async () => {
    const initial = dto("initial");
    host.list.mockResolvedValueOnce([meta(initial)]);
    host.load.mockResolvedValueOnce(initial);
    const oldList = deferred<SessionMetaDto[]>();
    const newList = deferred<SessionMetaDto[]>();
    host.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));

    let oldSync!: Promise<void>;
    let newSync!: Promise<void>;
    act(() => {
      oldSync = result.current.syncSessionsFromHost();
      newSync = result.current.syncSessionsFromHost();
    });
    const newest = dto("newest");
    host.load.mockResolvedValueOnce(newest);
    await act(async () => newList.resolve([meta(newest)]));
    await newSync;
    await act(async () => oldList.resolve([meta(dto("stale"))]));
    await oldSync;

    expect(result.current.sessions.some((session) => session.id === "newest")).toBe(true);
    expect(result.current.sessions.some((session) => session.id === "stale")).toBe(false);
  });
});
