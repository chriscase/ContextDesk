/**
 * @contextdesk/client — transport-neutral ContextDesk engine client.
 *
 * Target shape (design handoff §7): an `EngineClient` of domain services plus
 * a `TurnStream` abstraction and an injected `Platform` capability object,
 * satisfied by Tauri, HTTP (cd-server), and mock adapters. This batch ships
 * only the package identity; interfaces land with batch B4.
 */
export const CLIENT_PACKAGE = "@contextdesk/client" as const;
