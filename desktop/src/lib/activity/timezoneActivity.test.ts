import { describe, expect, it } from "vitest";
import { timezoneActivityEvent } from "./timezoneActivity";

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
