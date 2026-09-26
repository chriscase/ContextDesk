/**
 * SDK/transport-boundary proof. This is not live AWS qualification.
 * Canonical CopyObject attempts are counted inside the installed client's
 * request handler, below retry middleware.
 */
import { CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3EvidenceStore } from "./s3-store.js";

function countingClient(fail: "service" | "truncated"): { client: S3Client; copies: () => number } {
  let copies = 0;
  const client = new S3Client({
    region: "us-east-1",
    endpoint: "https://s3.example.test",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "synthetic-secret" },
    requestHandler: {
      destroy() {},
      async handle(request: { method?: string; headers?: Record<string, string> }) {
        const headers = request.headers ?? {};
        const copySource = headers["x-amz-copy-source"] ?? headers["X-Amz-Copy-Source"];
        if (request.method === "PUT" && copySource) copies += 1;
        if (fail === "service") {
          return {
            response: {
              statusCode: 500,
              reason: "InternalError",
              headers: { "x-amzn-errortype": "InternalError" },
              body: new Uint8Array(),
            },
          };
        }
        return {
          response: {
            statusCode: 200,
            reason: "OK",
            headers: { "content-type": "application/xml" },
            body: new Uint8Array(),
          },
        };
      },
    },
  });
  return { client, copies: () => copies };
}

describe("canonical CopyObject retry policy below SDK middleware", () => {
  it.each(["service", "truncated"] as const)(
    "does not replay a %s canonical copy",
    async (fail) => {
      const counted = countingClient(fail);
      const store = new S3EvidenceStore({
        bucket: "synthetic-bucket",
        region: "us-east-1",
        prefix: "evidence",
        client: counted.client as never,
      });
      await expect(store.copyObject("staging/a", "canonical/a", "promote")).rejects.toThrow(/s3 evidence/i);
      expect(counted.copies()).toBe(1);
      expect(new CopyObjectCommand({ Bucket: "b", Key: "k", CopySource: "b/s" })).toBeTruthy();
    },
  );
});
