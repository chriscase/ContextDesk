import { describe, expect, it } from "vitest";
import {
  disambiguateIdentities,
  evidenceIdentity,
  lanesCiting,
  readableReferenceName,
  type EvidenceIdentityContext,
} from "./evidence-identity.js";

/**
 * The regressions these tests pin come from the shipped War Room: the
 * cross-examination table rendered two different artifacts as identical rows,
 * and a lane's own path card credited its evidence to a different lane.
 */

const LANE_NAMES: Record<string, string> = {
  "cand-structured": "Structured run",
  "cand-chat": "Pasted chat",
};

function context(overrides: Partial<EvidenceIdentityContext> = {}): EvidenceIdentityContext {
  return {
    artifacts: [],
    traces: [
      {
        // Stored first on purpose: the old fallback always credited this lane.
        candidateId: "cand-chat",
        events: [
          {
            sequence: 2,
            kind: "assistant_response",
            actor: "assistant",
            excerpt: "The checkout log and inventory timeout line up.",
            evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
          },
        ],
      },
      {
        candidateId: "cand-structured",
        events: [
          {
            sequence: 3,
            kind: "tool_result",
            actor: "tool",
            excerpt: "checkout log shows inventory timeout",
            evidenceRefs: ["ev-demo-checkout-log"],
          },
          {
            sequence: 5,
            kind: "hypothesis",
            actor: "assistant",
            excerpt: "Inventory timeout is the leading cause.",
            evidenceRefs: ["ev-demo-inventory-timeout"],
          },
        ],
      },
    ],
    laneName: (id) => LANE_NAMES[id] ?? id,
    ...overrides,
  };
}

describe("readableReferenceName", () => {
  it("renders an identifier as words without its address prefix", () => {
    expect(readableReferenceName("ev-demo-checkout-log")).toBe("Demo checkout log");
    expect(readableReferenceName("evidence_inventory_timeout")).toBe("Inventory timeout");
    expect(readableReferenceName("ev-checkoutLatency")).toBe("Checkout Latency");
  });

  it("falls back to the reference when nothing readable remains", () => {
    expect(readableReferenceName("ev-")).toBe("ev-");
  });
});

describe("evidenceIdentity", () => {
  it("gives two distinct references two distinct names", () => {
    const ctx = context();
    const log = evidenceIdentity("ev-demo-checkout-log", ctx);
    const timeout = evidenceIdentity("ev-demo-inventory-timeout", ctx);
    expect(log.name).not.toBe(timeout.name);
    expect(log.name).toBe("Demo checkout log");
    expect(timeout.name).toBe("Demo inventory timeout");
  });

  it("prefers the rendering lane's own recorded step over another lane's", () => {
    const own = evidenceIdentity("ev-demo-checkout-log", context({ preferLane: "cand-structured" }));
    expect(own.excerpt).toBe("checkout log shows inventory timeout");
    expect(own.excerptCaveat).toContain("Structured run");
    expect(own.excerptCaveat).not.toContain("Pasted chat");
  });

  it("says when a borrowed excerpt covers several references at once", () => {
    // Only the chat lane cites this reference, and it cites two together.
    const shared = evidenceIdentity(
      "ev-demo-inventory-timeout",
      context({ preferLane: "cand-chat" }),
    );
    expect(shared.excerptCaveat).toContain("together with 1 other reference");
    expect(shared.excerptCaveat).toContain("not Demo inventory timeout alone");
  });

  it("reports a single-reference step as describing that reference alone", () => {
    const sole = evidenceIdentity(
      "ev-demo-inventory-timeout",
      context({ preferLane: "cand-structured" }),
    );
    expect(sole.excerptCaveat).toContain("on its own");
  });

  it("names every citing lane rather than one arbitrary lane", () => {
    expect(lanesCiting("ev-demo-checkout-log", context())).toEqual([
      "Pasted chat",
      "Structured run",
    ]);
    expect(evidenceIdentity("ev-demo-checkout-log", context()).citedByLanes).toHaveLength(2);
  });

  it("prefers an uploaded filename and marks the name as coming from the artifact", () => {
    const identity = evidenceIdentity(
      "ev-demo-checkout-log",
      context({
        artifacts: [
          {
            id: "ev-demo-checkout-log",
            kind: "log",
            filename: "checkout-timeout.log",
            uri: null,
            mediaType: "text/plain",
            privacyClass: "share_safe",
            verificationStatus: "verified",
          },
        ],
      }),
    );
    expect(identity.name).toBe("checkout-timeout.log");
    expect(identity.nameOrigin).toBe("artifact");
    expect(identity.unresolved).toBe(false);
  });

  it("marks a name derived from the reference as derived, not as a filename", () => {
    const identity = evidenceIdentity("ev-demo-checkout-log", context());
    expect(identity.nameOrigin).toBe("derived-from-reference");
  });

  it("reports an unbacked reference as unresolved without inventing content", () => {
    const identity = evidenceIdentity("ev-nothing-recorded", context());
    expect(identity.unresolved).toBe(true);
    expect(identity.excerpt).toBeNull();
    expect(identity.excerptCaveat).toContain("will not reconstruct");
  });

  it("prefers evidence-board text over any lane transcript", () => {
    const identity = evidenceIdentity(
      "ev-demo-checkout-log",
      context({
        artifacts: [
          {
            id: "ev-demo-checkout-log",
            kind: "log",
            filename: "checkout-timeout.log",
            uri: null,
            mediaType: "text/plain",
            privacyClass: "share_safe",
            verificationStatus: "verified",
          },
        ],
        loadedText: { "ev-demo-checkout-log": { text: "line one\nline two", truncated: true } },
      }),
    );
    expect(identity.excerptOrigin).toBe("evidence-board");
    expect(identity.excerpt).toBe("line one\nline two");
    expect(identity.excerptCaveat).toContain("bounded excerpt");
  });

  it("resolves the same reference the same way every time", () => {
    const first = evidenceIdentity("ev-demo-checkout-log", context());
    const second = evidenceIdentity("ev-demo-checkout-log", context());
    expect(first).toEqual(second);
  });
});

describe("disambiguateIdentities", () => {
  it("keeps distinct names untouched", () => {
    const ctx = context();
    const identities = disambiguateIdentities([
      evidenceIdentity("ev-demo-checkout-log", ctx),
      evidenceIdentity("ev-demo-inventory-timeout", ctx),
    ]);
    expect(identities.map((row) => row.name)).toEqual([
      "Demo checkout log",
      "Demo inventory timeout",
    ]);
  });

  it("separates two references that would otherwise read the same", () => {
    const artifacts = [
      {
        id: "ev-alpha-0001",
        kind: "log",
        filename: "service.log",
        uri: null,
        mediaType: "text/plain",
        privacyClass: "share_safe",
        verificationStatus: null,
      },
      {
        id: "ev-beta-0002",
        kind: "log",
        filename: "service.log",
        uri: null,
        mediaType: "text/plain",
        privacyClass: "share_safe",
        verificationStatus: null,
      },
    ];
    const ctx = context({ artifacts, traces: [] });
    const identities = disambiguateIdentities([
      evidenceIdentity("ev-alpha-0001", ctx),
      evidenceIdentity("ev-beta-0002", ctx),
    ]);
    expect(identities[0]!.name).not.toBe(identities[1]!.name);
    expect(identities[0]!.name).toContain("service.log");
    expect(identities[1]!.name).toContain("service.log");
  });
});
