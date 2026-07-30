import { render } from "@testing-library/react";
import { useId, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDismissibleLayer } from "./useDismissibleLayer";

function Layer({
  open,
  peerGroup,
  onDismiss,
}: {
  open: boolean;
  peerGroup: string;
  onDismiss: (restoreFocus: boolean) => void;
}) {
  const layerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer({
    open,
    layerId,
    peerGroup,
    rootRef,
    onDismiss,
  });
  return open ? <div ref={rootRef}>Layer</div> : null;
}

describe("useDismissibleLayer", () => {
  it("dismisses an already-open peer when another peer opens programmatically", () => {
    const dismissFirst = vi.fn();
    const dismissSecond = vi.fn();
    const view = render(
      <>
        <Layer
          open
          peerGroup="test-peers"
          onDismiss={dismissFirst}
        />
        <Layer
          open={false}
          peerGroup="test-peers"
          onDismiss={dismissSecond}
        />
      </>,
    );

    view.rerender(
      <>
        <Layer
          open
          peerGroup="test-peers"
          onDismiss={dismissFirst}
        />
        <Layer
          open
          peerGroup="test-peers"
          onDismiss={dismissSecond}
        />
      </>,
    );

    expect(dismissFirst).toHaveBeenCalledWith(false);
    expect(dismissSecond).not.toHaveBeenCalled();
  });
});
