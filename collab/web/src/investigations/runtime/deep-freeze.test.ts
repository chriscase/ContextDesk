import { describe, expect, it } from "vitest";
import { deepFreezeDto } from "./deep-freeze.js";

describe("deepFreezeDto", () => {
  it("freezes cyclic arrays and plain DTO objects without recursing forever", () => {
    const dto: { nested: { values: unknown[] }; self?: unknown } = {
      nested: { values: [] },
    };
    dto.self = dto;
    dto.nested.values.push(dto.nested, dto);

    expect(deepFreezeDto(dto)).toBe(dto);
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.nested)).toBe(true);
    expect(Object.isFrozen(dto.nested.values)).toBe(true);
  });

  it("does not traverse browser or class instances outside the DTO boundary", () => {
    class OpaqueValue {
      nested = { mutable: true };
    }
    const opaque = new OpaqueValue();
    const dto = { opaque };

    deepFreezeDto(dto);

    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(opaque)).toBe(false);
    expect(Object.isFrozen(opaque.nested)).toBe(false);
  });

  it("revisits accessor-bearing graphs whose getter can expose a new mutable child", () => {
    let childReads = 0;
    let child = { mutable: true };
    const dto = {
      get child() {
        childReads += 1;
        return child;
      },
    };

    deepFreezeDto(dto);
    expect(childReads).toBe(1);
    expect(Object.isFrozen(child)).toBe(true);

    child = { mutable: true };
    deepFreezeDto(dto);
    expect(childReads).toBe(2);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("does not cache an earlier member of a cycle before a later accessor disqualifies it", () => {
    let changingChild = { mutable: true };
    const a: { b?: unknown } = {};
    const c = { a };
    const b = {
      c,
      get changingChild() {
        return changingChild;
      },
    };
    a.b = b;

    deepFreezeDto(a);
    expect(Object.isFrozen(changingChild)).toBe(true);

    changingChild = { mutable: true };
    deepFreezeDto(c);

    expect(Object.isFrozen(changingChild)).toBe(true);
  });

  it("freezes shared callbacks without traversing function internals", () => {
    const mutableImplementationDetail = { mutable: true };
    const callback = Object.assign(() => undefined, {
      implementationDetail: mutableImplementationDetail,
    });
    const dto = { callback };

    deepFreezeDto(dto);

    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(callback)).toBe(true);
    expect(Object.isFrozen(mutableImplementationDetail)).toBe(false);
  });

  it("does not trust an externally frozen root to have frozen children", () => {
    const child = { mutable: true };
    const externallyFrozen = Object.freeze({ child });

    deepFreezeDto(externallyFrozen);

    expect(Object.isFrozen(externallyFrozen)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
  });
});
