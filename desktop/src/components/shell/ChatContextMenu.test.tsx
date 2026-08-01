import {
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../lib/session";
import { ChatContextMenu } from "./ChatContextMenu";

const session: ChatSession = {
  id: "session-1",
  title: "Incident review",
  messages: [],
  compactKeepLast: 6,
  showFullHistory: false,
  titleLocked: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archived: false,
  trashed: false,
  trashedAt: null,
  pinned: false,
  chatModel: null,
  providerProfileId: null,
  lastReadMessageId: null,
  pinnedSkillId: null,
  linkedCorpusId: null,
};

type HarnessProps = {
  position?: { x: number; y: number };
  outsidePointer?: (event: MouseEvent<HTMLButtonElement>) => void;
  onOutsideClick?: () => void;
  actions?: Partial<
    Pick<
      ComponentProps<typeof ChatContextMenu>,
      "onOpen" | "onRename" | "onTogglePin" | "onArchive" | "onTrash"
    >
  >;
};

function Harness({
  position = { x: 20, y: 30 },
  outsidePointer,
  onOutsideClick,
  actions = {},
}: HarnessProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeForAction = (action?: () => void) => () => {
    action?.();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onContextMenu={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        Incident review
      </button>
      <button
        type="button"
        onPointerDown={outsidePointer}
        onClick={onOutsideClick}
      >
        Outside destination
      </button>
      {open ? (
        <ChatContextMenu
          x={position.x}
          y={position.y}
          target={session}
          origin={triggerRef.current}
          onDismiss={() => setOpen(false)}
          onOpen={closeForAction(actions.onOpen)}
          onRename={closeForAction(actions.onRename)}
          onTogglePin={closeForAction(actions.onTogglePin)}
          onArchive={closeForAction(actions.onArchive)}
          onTrash={closeForAction(actions.onTrash)}
        />
      ) : null}
    </>
  );
}

function openMenu() {
  const trigger = screen.getByRole("button", { name: "Incident review" });
  fireEvent.contextMenu(trigger);
  return { trigger, menu: screen.getByRole("menu") };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChatContextMenu", () => {
  it("clamps a menu opened at the bottom-right inside the viewport", async () => {
    vi.stubGlobal("innerWidth", 1100);
    vi.stubGlobal("innerHeight", 800);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rect.mockReturnValue({
      bottom: 970,
      height: 180,
      left: 1088,
      right: 1256,
      top: 790,
      width: 168,
      x: 1088,
      y: 790,
      toJSON: () => ({}),
    });

    render(<Harness position={{ x: 1088, y: 790 }} />);
    const { menu } = openMenu();

    await waitFor(() => {
      expect(menu.style.left).toBe("924px");
      expect(menu.style.top).toBe("612px");
    });
  });

  it("enters on the first action and supports wrapped arrow, Home, and End navigation", async () => {
    render(<Harness />);
    const { menu } = openMenu();
    const items = screen.getAllByRole("menuitem");

    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("dismisses in capture phase even when the outside destination stops propagation", () => {
    const stopOutside = vi.fn((event: MouseEvent<HTMLButtonElement>) =>
      event.stopPropagation(),
    );
    render(<Harness outsidePointer={stopOutside} />);
    openMenu();

    const destination = screen.getByRole("button", {
      name: "Outside destination",
    });
    fireEvent.pointerDown(destination);

    expect(stopOutside).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("preserves focus on a real outside destination", () => {
    render(<Harness />);
    openMenu();
    const destination = screen.getByRole("button", {
      name: "Outside destination",
    });

    fireEvent.pointerDown(destination);
    destination.focus();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(destination);
  });

  it("keeps inside pointer interaction open until an action is chosen", () => {
    const onRename = vi.fn();
    render(<Harness actions={{ onRename }} />);
    const { menu } = openMenu();

    fireEvent.pointerDown(menu);
    fireEvent.click(menu);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the topmost menu with Escape and restores its originating trigger", async () => {
    render(<Harness />);
    const { trigger } = openMenu();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Open" }),
      ),
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not activate an underlying destination when a menu action is chosen", () => {
    const onOutsideClick = vi.fn();
    const onTrash = vi.fn();
    render(
      <Harness
        onOutsideClick={onOutsideClick}
        actions={{ onTrash }}
      />,
    );
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash…" }));

    expect(onTrash).toHaveBeenCalledTimes(1);
    expect(onOutsideClick).not.toHaveBeenCalled();
  });
});
