import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, sessionToDto } from "../lib/session";
import { useChatSessions } from "./useChatSessions";

const host = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), trash: vi.fn(), confirm: vi.fn(), message: vi.fn() }));
vi.mock("../lib/host", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/host")>(),
  hostListChatSessions: host.list,
  hostLoadChatSession: host.load,
  hostTrashChatSession: host.trash,
}));
vi.mock("../lib/dialogs", () => ({ dialogConfirm: host.confirm, dialogMessage: host.message }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const sessions = ["a", "b", "c"].map((id) => sessionToDto({ ...newSession(id), id }));
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  host.list.mockResolvedValue(sessions.map((s) => ({ ...s, message_count: 0 })));
  host.load.mockImplementation(async (id: string) => sessions.find((s) => s.id === id));
  host.confirm.mockResolvedValue(true);
});
describe("ordinary recoverable trash reconciliation", () => {
  it("does not override a newer selected chat when old trash finishes", async () => {
    const trash = deferred<typeof sessions[number]>();
    host.trash.mockReturnValueOnce(trash.promise);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    act(() => result.current.setActiveSessionId("a"));
    let pending!: Promise<void>;
    act(() => { pending = result.current.trashSessionById("a"); });
    await waitFor(() => expect(host.trash).toHaveBeenCalledWith("a"));
    act(() => result.current.setActiveSessionId("c"));
    await act(async () => { trash.resolve({ ...sessions[0]!, trashed: true }); await pending; });
    expect(result.current.sessions.map((s) => s.id)).toEqual(["b", "c"]);
    expect(result.current.activeSessionId).toBe("c");
  });
  it("retains the chat when the recoverable host mutation rejects", async () => {
    host.trash.mockRejectedValueOnce(new Error("synthetic storage failure"));
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    act(() => result.current.setActiveSessionId("a"));
    await act(async () => { await result.current.trashSessionById("a").catch(() => undefined); });
    expect(result.current.sessions.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(result.current.activeSessionId).toBe("a");
    expect(host.message).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("synthetic storage failure"),
      { title: "Move to Trash failed", kind: "error" },
    );
  });
  it("selects the first safe sibling when the trashed chat is still active", async () => {
    host.trash.mockResolvedValueOnce({ ...sessions[0]!, trashed: true });
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    act(() => result.current.setActiveSessionId("a"));
    await act(async () => { await result.current.trashSessionById("a"); });
    expect(result.current.activeSessionId).toBe("b");
    expect(host.message).not.toHaveBeenCalled();
  });
  it("coalesces repeated trash requests and leaves cancelled confirmation inert", async () => {
    const confirm = deferred<boolean>();
    host.confirm.mockReturnValueOnce(confirm.promise);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    let pending!: Promise<void>;
    act(() => { pending = result.current.trashSessionById("a"); });
    await act(async () => { await result.current.trashSessionById("a"); });
    await act(async () => { confirm.resolve(false); await pending; });
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect(host.trash).not.toHaveBeenCalled();
    expect(result.current.sessions).toHaveLength(3);
  });
  it("creates a usable empty chat when the last open chat is trashed", async () => {
    host.trash.mockResolvedValueOnce({ ...sessions[0]!, trashed: true });
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    act(() => { result.current.setSessions((all) => all.filter((s) => s.id === "a")); result.current.setActiveSessionId("a"); });
    await act(async () => { await result.current.trashSessionById("a"); });
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.activeSessionId).toBe(result.current.sessions[0]!.id);
    expect(result.current.activeSessionId).not.toBe("a");
    expect(result.current.messages).toEqual([]);
  });
  it("keeps the last-chat fallback identity stable under production StrictMode", async () => {
    host.trash.mockResolvedValueOnce({ ...sessions[0]!, trashed: true });
    const { result } = renderHook(() => useChatSessions(), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    act(() => { result.current.setSessions((all) => all.filter((s) => s.id === "a")); result.current.setActiveSessionId("a"); });
    await act(async () => { await result.current.trashSessionById("a"); });
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.activeSessionId).toBe(result.current.sessions[0]!.id);
    expect(result.current.activeSessionId).not.toBe("a");
    act(() => result.current.setMessages([{ id: "first", role: "user", content: "new chat first turn" }]));
    expect(result.current.sessions[0]!.messages[0]?.content).toBe("new chat first turn");
  });
  it("keeps a UI-only unsaved chat and its draft without promising recovery", async () => {
    const hasDraft = vi.fn(() => true);
    const { result } = renderHook(() => useChatSessions({ hasDraft }));
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    const unsaved = { ...newSession("Untitled draft"), id: "unsaved" };
    act(() => { result.current.setSessions([unsaved]); result.current.setActiveSessionId(unsaved.id); });
    await act(async () => { await result.current.trashSessionById(unsaved.id); });
    expect(result.current.sessions).toEqual([unsaved]);
    expect(result.current.activeSessionId).toBe(unsaved.id);
    expect(host.confirm).not.toHaveBeenCalled();
    expect(host.trash).not.toHaveBeenCalled();
    expect(host.message).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("unsaved chat"), { title: "Chat not saved", kind: "info" },
    );
  });
  it("fails closed when the host does not acknowledge trash", async () => {
    host.trash.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.sessionsReady).toBe(true));
    await act(async () => { await result.current.trashSessionById("a"); });
    expect(result.current.sessions).toHaveLength(3);
    expect(host.message).toHaveBeenCalledTimes(1);
  });
});
