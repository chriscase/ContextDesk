/**
 * @contextdesk/contracts — versioned wire DTO types and strict runtime
 * parsers for the ContextDesk engine boundary (`cd.v1`).
 *
 * Source-consumed package: the desktop app imports these TypeScript sources
 * directly through its bundler aliases; there is no build step and there are
 * no runtime dependencies. The Rust side (cd-core / the Tauri host) remains
 * the authority for every wire shape — this package mirrors it and proves the
 * mirror against committed Rust-generated fixtures (`fixtures/contracts/`).
 */

/** Package identity for smoke tests and boundary probes. */
export const CONTRACTS_PACKAGE = "@contextdesk/contracts" as const;

/** The wire/event-stream contract generation this package mirrors. */
export const CD_WIRE_VERSION = "cd.v1" as const;
