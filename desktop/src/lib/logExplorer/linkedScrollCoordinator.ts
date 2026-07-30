const SCROLL_TOLERANCE_PX = 1;

export type LinkedScrollPort = {
  readTop: () => number;
  applyTop: (scrollTop: number) => number;
};

export type LinkedScrollCoordinator = {
  register: (laneId: string, port: LinkedScrollPort) => () => void;
  syncFrom: (laneId: string, scrollTop: number) => void;
  reset: (scrollTop?: number) => void;
};

type RegisteredPort = {
  port: LinkedScrollPort;
  echoTop: number | null;
};

function samePosition(left: number, right: number): boolean {
  return Math.abs(left - right) <= SCROLL_TOLERANCE_PX;
}

/**
 * Imperatively keeps resident aligned lanes on one pixel coordinate.
 *
 * React state is deliberately absent from this hot path: the manipulated
 * lane and every peer update in the originating scroll task. Programmatic
 * peer scroll events are recognized as echoes, while a genuine subsequent
 * user movement is still broadcast.
 */
export function createLinkedScrollCoordinator(): LinkedScrollCoordinator {
  const ports = new Map<string, RegisteredPort>();
  let canonicalTop = 0;

  const applyToPort = (registered: RegisteredPort, nextTop: number) => {
    if (samePosition(registered.port.readTop(), nextTop)) return;
    registered.echoTop = registered.port.applyTop(nextTop);
  };

  return {
    register(laneId, port) {
      const registered: RegisteredPort = { port, echoTop: null };
      const hadPeers = ports.size > 0;
      ports.set(laneId, registered);
      if (hadPeers) {
        applyToPort(registered, canonicalTop);
      } else {
        canonicalTop = port.readTop();
      }

      return () => {
        if (ports.get(laneId) === registered) ports.delete(laneId);
      };
    },

    syncFrom(laneId, scrollTop) {
      const source = ports.get(laneId);
      if (!source) return;

      const isEcho =
        source.echoTop != null && samePosition(source.echoTop, scrollTop);
      source.echoTop = null;
      canonicalTop = scrollTop;
      if (isEcho) return;

      for (const [peerId, peer] of ports) {
        if (peerId !== laneId) applyToPort(peer, scrollTop);
      }
    },

    reset(scrollTop = 0) {
      canonicalTop = scrollTop;
      for (const registered of ports.values()) {
        applyToPort(registered, scrollTop);
      }
    },
  };
}
