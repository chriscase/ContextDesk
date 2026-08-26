import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  PORTABLE_APPLY_REQUEST_SCHEMA_ID,
  PORTABLE_APPLY_RESPONSE_SCHEMA_ID,
  PORTABLE_APPLY_TYPED_CONFIRMATION,
  identityMapDigest,
  parsePortableApplyRequest,
  parsePortableApplyResponse,
  portableApplyDeepLink,
} from "./investigation-portable-apply.js";

const SYNTHETIC_INVESTIGATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function validRequest(overlay: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: PORTABLE_APPLY_REQUEST_SCHEMA_ID,
    confirmationToken: "pit1.synthetic-token",
    typedConfirmation: PORTABLE_APPLY_TYPED_CONFIRMATION,
    collisionPolicy: "remap_deterministic",
    identityMap: [
      {
        sourceActorId: "historical-operator",
        action: "preserve_historical_external",
        destinationActorId: null,
      },
    ],
    archive: { schemaId: "cd-collab.investigation_portable_archive.v1" },
    ...overlay,
  };
}

function validResponse(overlay: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: PORTABLE_APPLY_RESPONSE_SCHEMA_ID,
    status: "applied",
    investigationId: SYNTHETIC_INVESTIGATION_ID,
    deepLink: portableApplyDeepLink(SYNTHETIC_INVESTIGATION_ID),
    transportHash: "ab".repeat(32),
    semanticFingerprint: "cd".repeat(32),
    destinationCatalogDigest: "ef".repeat(32),
    authenticityClaim: "none",
    destinationMembershipGranted: false,
    destinationRoleGranted: false,
    destinationCapabilityGranted: false,
    ...overlay,
  };
}

describe("portable apply contract", () => {
  it("parses a fail-closed apply request and response", () => {
    const request = parsePortableApplyRequest(validRequest());
    expect(request.typedConfirmation).toBe("RESTORE");
    expect(request.confirmationToken).toBe("pit1.synthetic-token");
    const response = parsePortableApplyResponse(validResponse());
    expect(response.deepLink).toBe(`/investigations/${SYNTHETIC_INVESTIGATION_ID}/situation`);
    expect(response.authenticityClaim).toBe("none");
  });

  it("rejects unknown fields, empty tokens, and non-RESTORE confirmation", () => {
    expect(() => parsePortableApplyRequest(validRequest({ extra: true }))).toThrow(ContractViolation);
    expect(() =>
      parsePortableApplyRequest(validRequest({ confirmationToken: "   " })),
    ).toThrow(/confirmationToken/);
    expect(() =>
      parsePortableApplyRequest(validRequest({ typedConfirmation: "restore" })),
    ).toThrow(ContractViolation);
    expect(() =>
      parsePortableApplyRequest(
        validRequest({
          identityMap: [
            {
              sourceActorId: "historical-operator",
              action: "preserve_historical_external",
              destinationActorId: null,
              planted: true,
            },
          ],
        }),
      ),
    ).toThrow(/unknown key/);
    expect(() => parsePortableApplyRequest(validRequest({ archive: "not-an-object" }))).toThrow(
      /archive/,
    );
  });

  it("does not mistake random server-minted token bytes for embedded credentials", () => {
    const tokenWithCredentialLikeEntropy = "pit1.synthetic-sk-abcdefgh-tail";
    expect(
      parsePortableApplyRequest(
        validRequest({ confirmationToken: tokenWithCredentialLikeEntropy }),
      ).confirmationToken,
    ).toBe(tokenWithCredentialLikeEntropy);
  });

  it("rejects malformed supplied blob inventories instead of ignoring them", () => {
    expect(() => parsePortableApplyRequest(validRequest({ suppliedBlobs: {} }))).toThrow(
      /suppliedBlobs/,
    );
    expect(() =>
      parsePortableApplyRequest(
        validRequest({
          suppliedBlobs: [
            {
              digest: "ab".repeat(32),
              byteLength: 4,
              contentType: "text/plain",
              presence: "inline",
            },
          ],
        }),
      ),
    ).toThrow(/payloadBase64/);
    expect(() =>
      parsePortableApplyRequest(
        validRequest({
          suppliedBlobs: [
            {
              digest: "ab".repeat(32),
              byteLength: 4,
              contentType: "text/plain",
              presence: "inline",
              payloadBase64: "dGVzdA==",
              planted: true,
            },
          ],
        }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parsePortableApplyRequest(
        validRequest({
          suppliedBlobs: [
            {
              digest: "ab".repeat(32),
              byteLength: 4,
              contentType: "text/plain",
              presence: "detached",
              payloadBase64: "dGVzdA==",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("never accepts destination membership, role, or capability grants", () => {
    expect(() =>
      parsePortableApplyResponse(validResponse({ destinationMembershipGranted: true })),
    ).toThrow(/must not grant/);
    expect(() =>
      parsePortableApplyResponse(validResponse({ destinationRoleGranted: true })),
    ).toThrow(/must not grant/);
    expect(() =>
      parsePortableApplyResponse(validResponse({ authenticityClaim: "ed25519" })),
    ).toThrow(ContractViolation);
    expect(() => parsePortableApplyResponse(validResponse({ extra: 1 }))).toThrow(/unknown key/);
  });

  it("digests identity maps independently of input order", () => {
    const left = identityMapDigest([
      { sourceActorId: "b", action: "preserve_historical_external", destinationActorId: null },
      { sourceActorId: "a", action: "map_existing", destinationActorId: "dest-a" },
    ]);
    const right = identityMapDigest([
      { sourceActorId: "a", action: "map_existing", destinationActorId: "dest-a" },
      { sourceActorId: "b", action: "preserve_historical_external", destinationActorId: null },
    ]);
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });
});
