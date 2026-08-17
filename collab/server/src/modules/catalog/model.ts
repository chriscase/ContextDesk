import {
  SOURCE_KINDS,
  SOURCE_LIFECYCLES,
  type SourceKind,
  type SourceLifecycle,
} from "@cd-collab/contracts";

export { SOURCE_KINDS, SOURCE_LIFECYCLES, type SourceKind, type SourceLifecycle };

export function isSourceKind(value: string): value is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(value);
}

export function isSourceLifecycle(value: string): value is SourceLifecycle {
  return (SOURCE_LIFECYCLES as readonly string[]).includes(value);
}
