import { describe, expect, it } from "vitest";
import {
  nextRovingIndex,
  streamAnnouncementSlice,
  trapTabKey,
} from "./a11y";

describe("streamAnnouncementSlice", () => {
  it("returns empty for blank", () => {
    expect(streamAnnouncementSlice("", true)).toBe("");
    expect(streamAnnouncementSlice("   ", false)).toBe("");
  });

  it("on complete stream returns full text (capped)", () => {
    expect(streamAnnouncementSlice("Hello world.", false)).toBe("Hello world.");
  });

  it("while streaming announces last complete sentence only", () => {
    const t = "First sentence. Second is going";
    expect(streamAnnouncementSlice(t, true)).toBe("First sentence.");
  });

  it("while streaming with two sentences takes the last complete", () => {
    const t = "One. Two. Three more";
    expect(streamAnnouncementSlice(t, true)).toBe("Two.");
  });
});

describe("nextRovingIndex", () => {
  it("moves left/right with wrap", () => {
    expect(nextRovingIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextRovingIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextRovingIndex(0, 3, "ArrowLeft")).toBe(2);
  });

  it("Home and End", () => {
    expect(nextRovingIndex(2, 5, "Home")).toBe(0);
    expect(nextRovingIndex(0, 5, "End")).toBe(4);
  });

  it("ignores unrelated keys", () => {
    expect(nextRovingIndex(1, 3, "Enter")).toBeNull();
  });
});

describe("trapTabKey", () => {
  it("cycles from last to first on Tab", () => {
    const root = document.createElement("div");
    const a = document.createElement("button");
    const b = document.createElement("button");
    root.append(a, b);
    document.body.append(root);
    b.focus();
    let prevented = false;
    const handled = trapTabKey(
      {
        key: "Tab",
        shiftKey: false,
        preventDefault: () => {
          prevented = true;
        },
      },
      root,
      b,
    );
    expect(handled).toBe(true);
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(a);
    root.remove();
  });
});
