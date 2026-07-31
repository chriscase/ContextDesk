/**
 * Engine adapter boundary — `src/lib/engine/` is the ONE designated home for
 * Tauri IPC and `src/lib/host` usage going forward (design handoff §7).
 *
 * The boundary ratchet (`src/lib/boundary/`) exempts this directory: adapters
 * placed here (the Tauri delegation adapter lands with batch B4) may import
 * `../host` and `@tauri-apps/*`; nothing else new may. This file also proves,
 * in production code covered by `tsc -b`, that the `@contextdesk/*` source
 * aliases resolve from the desktop dependency graph.
 */
import { CD_WIRE_VERSION } from "@contextdesk/contracts";

/** The engine wire generation this desktop build speaks. */
export const ENGINE_WIRE_VERSION: typeof CD_WIRE_VERSION = CD_WIRE_VERSION;
