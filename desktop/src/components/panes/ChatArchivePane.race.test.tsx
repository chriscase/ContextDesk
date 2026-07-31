/**
 * Archive search must not settle on a stale response.
 *
 * `runSearch` fires on every debounced query and on every scope change, so
 * several requests are routinely in flight. Without sequencing, the slowest
 * response wins — showing results for an older query, or Trash rows under the
 * Chats tab — and a stale `finally` clears the spinner while the newest search
 * is still running.
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchHitDto } from "../../lib/host";
import { ChatArchivePane } from "./ChatArchivePane";

const host = vi.hoisted(() => ({ hostSearchChatSessions: vi.fn() }));

vi.mock("../../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/host")>();
  return { ...original, hostSearchChatSessions: host.hostSearchChatSessions };
});

function hit(id: string, title: string): SessionSearchHitDto {
  return {
    meta: {
      id,
      title,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      archived: false,
      trashed: false,
      pinned: false,
      message_count: 2,
    },
    snippet: title,
  } as unknown as SessionSearchHitDto;
}

/** A search whose resolution this test controls. */
function deferred() {
  let resolve!: (hits: SessionSearchHitDto[]) => void;
  const promise = new Promise<SessionSearchHitDto[]>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("archive search sequencing", () => {
  it("keeps the newest results when an older response lands last", async () => {
    const first = deferred();
    const second = deferred();
    host.hostSearchChatSessions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(
      <ChatArchivePane
        refreshKey={0}
        activeSessionId="s-1"
        onOpenSession={vi.fn()}
      />,
    );
    // A second search supersedes the first while it is still in flight.
    rerender(
      <ChatArchivePane
        refreshKey={1}
        activeSessionId="s-1"
        onOpenSession={vi.fn()}
      />,
    );

    // Newest resolves first, then the stale one arrives.
    await act(async () => {
      second.resolve([hit("s-new", "Newest result")]);
      await second.promise;
    });
    await act(async () => {
      first.resolve([hit("s-old", "Stale result")]);
      await first.promise;
    });

    const list = await screen.findByRole("list");
    expect(within(list).queryAllByText(/Newest result/).length).toBeGreaterThan(0);
    expect(within(list).queryAllByText(/Stale result/)).toHaveLength(0);
  });

  it("does not let a stale response clear the spinner for a live search", async () => {
    const first = deferred();
    const second = deferred();
    host.hostSearchChatSessions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(
      <ChatArchivePane refreshKey={0} onOpenSession={vi.fn()} />,
    );
    rerender(<ChatArchivePane refreshKey={1} onOpenSession={vi.fn()} />);

    await act(async () => {
      first.resolve([hit("s-old", "Stale result")]);
      await first.promise;
    });

    // The newest search has not answered yet, so the pane must still say so.
    expect(screen.queryByText("Searching…")).not.toBeNull();

    await act(async () => {
      second.resolve([hit("s-new", "Newest result")]);
      await second.promise;
    });
    await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
  });

  it("discards a stale failure rather than showing it over live results", async () => {
    const first = deferred();
    const second = deferred();
    host.hostSearchChatSessions
      .mockReturnValueOnce(
        first.promise.then(() => {
          throw new Error("stale backend failure");
        }),
      )
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(
      <ChatArchivePane refreshKey={0} onOpenSession={vi.fn()} />,
    );
    rerender(<ChatArchivePane refreshKey={1} onOpenSession={vi.fn()} />);

    await act(async () => {
      second.resolve([hit("s-new", "Newest result")]);
      await second.promise;
    });
    await act(async () => {
      first.resolve([]);
      await first.promise.catch(() => {});
    });

    expect(screen.queryByText(/stale backend failure/)).toBeNull();
    const list = await screen.findByRole("list");
    expect(within(list).queryAllByText(/Newest result/).length).toBeGreaterThan(0);
  });
});
