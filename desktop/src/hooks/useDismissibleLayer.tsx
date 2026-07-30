import {
  createContext,
  useEffect,
  type RefObject,
} from "react";

export const DismissibleLayerContext = createContext<string | null>(null);

type DismissibleLayerOptions = {
  open: boolean;
  layerId: string;
  peerGroup?: string;
  rootRef: RefObject<HTMLElement | null>;
  onDismiss: (restoreFocus: boolean) => void;
};

const openLayerStack: string[] = [];
const peerGroups = new Map<
  string,
  Map<string, (restoreFocus: boolean) => void>
>();

function removeOpenLayer(layerId: string) {
  const index = openLayerStack.lastIndexOf(layerId);
  if (index >= 0) openLayerStack.splice(index, 1);
}

function eventStaysInsideLayer(
  event: Event,
  root: HTMLElement | null,
  layerId: string,
): boolean {
  const target = event.target;
  if (root && target instanceof Node && root.contains(target)) return true;

  const path =
    typeof event.composedPath === "function" ? event.composedPath() : [];
  if (root && path.includes(root)) return true;

  return path.some(
    (candidate) =>
      candidate instanceof HTMLElement &&
      candidate.dataset.dismissibleLayerBranch === layerId,
  );
}

/**
 * Shared non-modal dismissal contract.
 *
 * Capture-phase pointer dismissal cannot be defeated by an unrelated
 * stopPropagation call. The click fallback also covers keyboard and
 * programmatic activation. Portaled descendants opt in through
 * DismissibleLayerContext and data-dismissible-layer-branch.
 */
export function useDismissibleLayer({
  open,
  layerId,
  peerGroup,
  rootRef,
  onDismiss,
}: DismissibleLayerOptions) {
  useEffect(() => {
    if (!open) return;

    removeOpenLayer(layerId);
    openLayerStack.push(layerId);
    if (peerGroup) {
      const peers = peerGroups.get(peerGroup) ?? new Map();
      for (const [peerId, dismissPeer] of peers) {
        if (peerId !== layerId) dismissPeer(false);
      }
      peers.set(layerId, onDismiss);
      peerGroups.set(peerGroup, peers);
    }

    const dismissOutside = (event: Event) => {
      if (eventStaysInsideLayer(event, rootRef.current, layerId)) return;
      onDismiss(false);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        openLayerStack[openLayerStack.length - 1] !== layerId
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onDismiss(true);
    };

    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("click", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    document.addEventListener("keydown", dismissWithEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("click", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
      document.removeEventListener("keydown", dismissWithEscape, true);
      removeOpenLayer(layerId);
      if (peerGroup) {
        const peers = peerGroups.get(peerGroup);
        peers?.delete(layerId);
        if (peers?.size === 0) peerGroups.delete(peerGroup);
      }
    };
  }, [layerId, onDismiss, open, peerGroup, rootRef]);
}
