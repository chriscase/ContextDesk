import { describe, expect, it } from "vitest";
import {
  createTimezoneActivityLog,
  recordTimezoneActivity,
  TIMEZONE_ACTIVITY_CAP,
  timezoneActivityEvent,
} from "./timezoneActivity";

describe("timezoneActivityEvent", () => {
  it("emits user_decision apply with deterministic classification from origin", () => {
    const event = timezoneActivityEvent({
      corpusId: "c1",
      correlationId: "import:c1:tz",
      outcome: "applied",
      zone: "America/Chicago",
      sourceCount: 3,
    });
    expect(event.origin).toBe("user_decision");
    expect(event.determinism).toBe("human");
    expect(event.label).toMatch(/Timezone applied/i);
    expect(event.status).toBe("ok");
    expect(event.corpusId).toBe("c1");
    expect(event.detail).toContain("America/Chicago");
  });

  it("records undo and cancel as terminal human outcomes", () => {
    expect(
      timezoneActivityEvent({
        corpusId: "c1",
        correlationId: "import:c1:tz",
        outcome: "undone",
      }).status,
    ).toBe("ok");
    expect(
      timezoneActivityEvent({
        corpusId: "c1",
        correlationId: "import:c1:tz",
        outcome: "cancelled",
      }).status,
    ).toBe("cancelled");
  });
});

describe("recordTimezoneActivity — LogPane accumulation path", () => {
  it("bounds growth and records omitted counts (not an unbounded array)", () => {
    // Same path LogPane.applyTimezone / clearTimezone call: recordTimezoneActivity
    // onto createTimezoneActivityLog, not raw [...current, event].
    let log = createTimezoneActivityLog(3);
    expect(TIMEZONE_ACTIVITY_CAP).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      log = recordTimezoneActivity(log, {
        corpusId: "corpus-tz",
        outcome: i % 2 === 0 ? "applied" : "undone",
        zone: "America/Chicago",
        sourceCount: 1,
      });
    }
    expect(log.entries.length).toBe(3);
    expect(log.omitted).toBe(2);
    expect(log.cap).toBe(3);
    // Newest retained
    expect(log.entries.at(-1)?.label).toMatch(/Timezone/i);
    // Never grew past the cap
    expect(log.entries.length).toBeLessThanOrEqual(log.cap);
  });

  it("default process-local cap matches the Logs pane constant", () => {
    const log = createTimezoneActivityLog();
    expect(log.cap).toBe(TIMEZONE_ACTIVITY_CAP);
  });
});
