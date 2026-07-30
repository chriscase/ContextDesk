import { describe, expect, it } from "vitest";
import {
  createLinkedScrollCoordinator,
  type LinkedScrollPort,
} from "./linkedScrollCoordinator";

function testPort(initialTop = 0): {
  port: LinkedScrollPort;
  applications: number[];
  moveTo: (scrollTop: number) => void;
  top: () => number;
} {
  let currentTop = initialTop;
  const applications: number[] = [];
  return {
    port: {
      readTop: () => currentTop,
      applyTop: (scrollTop) => {
        currentTop = scrollTop;
        applications.push(scrollTop);
        return currentTop;
      },
    },
    applications,
    moveTo: (scrollTop) => {
      currentTop = scrollTop;
    },
    top: () => currentTop,
  };
}

describe("linkedScrollCoordinator", () => {
  it("synchronizes either leader immediately without rebroadcasting echoes", () => {
    const coordinator = createLinkedScrollCoordinator();
    const first = testPort();
    const second = testPort();
    coordinator.register("first", first.port);
    coordinator.register("second", second.port);

    first.moveTo(42);
    coordinator.syncFrom("first", 42);
    expect(second.top()).toBe(42);
    expect(second.applications).toEqual([42]);

    coordinator.syncFrom("second", 42);
    expect(first.applications).toEqual([]);

    second.moveTo(64);
    coordinator.syncFrom("second", 64);
    expect(first.top()).toBe(64);
    expect(first.applications).toEqual([64]);
  });

  it("adopts the canonical position for newly mounted lanes and reset", () => {
    const coordinator = createLinkedScrollCoordinator();
    const first = testPort(18);
    coordinator.register("first", first.port);
    first.moveTo(96);
    coordinator.syncFrom("first", 96);

    const second = testPort();
    const unregisterSecond = coordinator.register("second", second.port);
    expect(second.top()).toBe(96);

    coordinator.reset(0);
    expect(first.top()).toBe(0);
    expect(second.top()).toBe(0);

    unregisterSecond();
    first.moveTo(25);
    coordinator.syncFrom("first", 25);
    expect(second.top()).toBe(0);
  });

  it("keeps one-pixel tolerance from creating scroll fights", () => {
    const coordinator = createLinkedScrollCoordinator();
    const first = testPort(100);
    const second = testPort(101);
    coordinator.register("first", first.port);
    coordinator.register("second", second.port);

    coordinator.syncFrom("first", 100);
    expect(second.applications).toEqual([]);
  });
});
