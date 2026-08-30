function isPlainDtoObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Only entries placed here by deepFreezeDto are trusted. Object.isFrozen is
// deliberately insufficient: an externally frozen root may still reference
// mutable children that this utility must visit.
const fullyFrozenDtoGraphs = new WeakSet<object>();

/**
 * Freezes browser-owned DTO graphs without traversing class instances or host
 * objects. The WeakSet makes shared references and accidental cycles safe.
 */
export function deepFreezeDto<T>(value: T): T {
  const visiting = new WeakSet<object>();

  const freeze = (candidate: unknown): boolean => {
    if (typeof candidate === "function") {
      // Runtime callbacks are shared strategy-facing values. Freeze their own
      // surface, but never traverse implementation properties or closures.
      Object.freeze(candidate);
      return true;
    }
    if (typeof candidate !== "object" || candidate === null) return true;
    if (!Array.isArray(candidate) && !isPlainDtoObject(candidate)) return true;
    if (fullyFrozenDtoGraphs.has(candidate)) return true;
    // A back-edge terminates traversal but makes the entire cyclic component
    // ineligible for cross-call caching. A later node in that component may
    // expose a changing accessor that an earlier member cannot yet see.
    if (visiting.has(candidate)) return false;
    visiting.add(candidate);

    let cacheEligible = true;
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined) {
        cacheEligible = false;
        continue;
      }
      if ("value" in descriptor) {
        if (!freeze(descriptor.value)) cacheEligible = false;
        continue;
      }

      // A frozen accessor can still return a different mutable child later.
      // Freeze its current value, but never trust this node (or an ancestor
      // containing it) in the cross-call cache.
      cacheEligible = false;
      if (descriptor.get !== undefined) {
        freeze(descriptor.get.call(candidate));
      }
    }
    Object.freeze(candidate);
    visiting.delete(candidate);
    if (cacheEligible) fullyFrozenDtoGraphs.add(candidate);
    return cacheEligible;
  };

  freeze(value);
  return value;
}
