import { describe, expect, it } from "vitest";
import type { EventDto } from "./host";
import { applyEventsToMessage, shortSourceLabel, type ChatMsg } from "./turn";

function base(partial: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    ...partial,
  };
}

describe("shortSourceLabel", () => {
  it("extracts publisher after dash and shortens http labels", () => {
    expect(
      shortSourceLabel("IRGC commander reported killed - Al Jazeera", "x"),
    ).toBe("Al Jazeera");
    expect(shortSourceLabel("https://www.bbc.com/news/a", "https://www.bbc.com/news/a")).toBe(
      "bbc.com",
    );
    expect(
      shortSourceLabel("https://news.google.com/rss/…", "https://news.google.com/rss/…"),
    ).toBe("Google News");
  });
});

describe("applyEventsToMessage", () => {
  it("concatenates text_delta", () => {
    const events: EventDto[] = [
      { kind: "text_delta", payload: { text: "Hello" } },
      { kind: "text_delta", payload: { text: " world" } },
    ];
    const { msg } = applyEventsToMessage(base(), events);
    expect(msg.content).toBe("Hello world");
  });

  /** #108 live Channel path: event-by-event fold equals batch fold. */
  it("incremental single-event fold equals batch fold", () => {
    const events: EventDto[] = [
      { kind: "tool", payload: { id: "t1", name: "search_kb", summary: "go", ok: true } },
      { kind: "text_delta", payload: { text: "Hello" } },
      { kind: "text_delta", payload: { text: " live" } },
      {
        kind: "citation",
        payload: { source_id: "a.md", label: "a.md", locator: null },
      },
      { kind: "turn_completed", payload: { reason: "stop" } },
    ];
    let live = base();
    for (const ev of events) {
      live = applyEventsToMessage(live, [ev]).msg;
    }
    const batch = applyEventsToMessage(base(), events).msg;
    expect(live.content).toBe(batch.content);
    expect(live.content).toBe("Hello live");
    expect(live.tools?.map((t) => t.name)).toEqual(batch.tools?.map((t) => t.name));
    expect(live.citations?.map((c) => c.id)).toEqual(batch.citations?.map((c) => c.id));
  });

  it("turn_started sets host_confirmed model provenance (#155)", () => {
    const { msg } = applyEventsToMessage(
      base({
        meta: {
          model: "requested-model",
          requested_model: "requested-model",
          host_confirmed: false,
        },
      }),
      [
        {
          kind: "turn_started",
          payload: { session_id: "s1", model: "llama3.2:latest" },
        },
      ],
    );
    expect(msg.meta?.model).toBe("llama3.2:latest");
    expect(msg.meta?.host_confirmed).toBe(true);
  });

  it("permission_required surfaces on a single mid-turn event", () => {
    const { permission } = applyEventsToMessage(base({ content: "partial" }), [
      {
        kind: "permission_required",
        payload: {
          request_id: "r1",
          tool_name: "save_memory",
          target: "notes.md",
          reason: "write",
          preview: "x",
          risk: "local",
        },
      },
    ]);
    expect(permission?.requestId).toBe("r1");
    expect(permission?.toolName).toBe("save_memory");
  });

  it("upserts tools by id", () => {
    const events: EventDto[] = [
      {
        kind: "tool",
        payload: { id: "t1", name: "web_search", summary: "start", ok: null },
      },
      {
        kind: "tool",
        payload: {
          id: "t1",
          name: "web_search",
          summary: "done",
          detail: "raw",
          ok: true,
        },
      },
    ];
    const { msg } = applyEventsToMessage(base(), events);
    expect(msg.tools).toHaveLength(1);
    expect(msg.tools?.[0]).toMatchObject({
      id: "t1",
      summary: "done",
      detail: "raw",
      ok: true,
    });
  });

  it("dedupes citations and shortens long/URL labels", () => {
    const url = "https://www.example.com/long/path/article";
    const events: EventDto[] = [
      {
        kind: "citation",
        payload: { source_id: url, label: url, locator: "Title" },
      },
      {
        kind: "citation",
        payload: { source_id: url, label: url, locator: "dup" },
      },
    ];
    const { msg } = applyEventsToMessage(base(), events);
    expect(msg.citations).toHaveLength(1);
    expect(msg.citations?.[0].label).toBe("example.com");
    expect(msg.citations?.[0].title).toBe("Title");
  });

  it("builds permission prompt with WRITE phrase for remote/destructive", () => {
    const remote: EventDto[] = [
      {
        kind: "permission_required",
        payload: {
          request_id: "r1",
          tool_name: "save_memory",
          target: "/tmp/a",
          reason: "write",
          preview: "body",
          risk: "remote",
        },
      },
    ];
    const { permission } = applyEventsToMessage(base(), remote);
    expect(permission).toMatchObject({
      requestId: "r1",
      toolName: "save_memory",
      typeConfirmPhrase: "WRITE",
      risk: "remote",
    });

    const local: EventDto[] = [
      {
        kind: "permission_required",
        payload: {
          request_id: "r2",
          tool_name: "save_memory",
          target: "note",
          reason: "write",
          preview: "body",
          risk: "local",
        },
      },
    ];
    const localPerm = applyEventsToMessage(base(), local).permission;
    expect(localPerm?.typeConfirmPhrase).toBeNull();
  });
});
