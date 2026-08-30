import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_UPLOAD_BYTES } from "../types.js";
import { prepareEvidenceUpload } from "./file-base64.js";

class ObservedBlob extends Blob {
  reads = 0;

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.reads += 1;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (reader.result instanceof ArrayBuffer) resolve(reader.result);
        else reject();
      }, { once: true });
      reader.addEventListener("error", () => reject(), { once: true });
      reader.readAsArrayBuffer(this);
    });
  }
}

class UnreadableBlob extends Blob {
  override async arrayBuffer(): Promise<ArrayBuffer> {
    throw new TypeError("private read failure");
  }
}

describe("prepareEvidenceUpload", () => {
  it("returns bounded required failures before reading", async () => {
    expect(await prepareEvidenceUpload(undefined, "summary")).toEqual({
      status: "failed",
      error: { kind: "input", field: "file", reason: "required" },
    });

    const file = new ObservedBlob(["contents"]);
    expect(await prepareEvidenceUpload(file, "   ")).toEqual({
      status: "failed",
      error: { kind: "input", field: "summary", reason: "required" },
    });
    expect(file.reads).toBe(0);
  });

  it("accepts exactly 1,000,000 bytes", async () => {
    const file = new ObservedBlob([new Uint8Array(MAX_EVIDENCE_UPLOAD_BYTES)]);
    const outcome = await prepareEvidenceUpload(file, " boundary evidence ");

    expect(outcome.status).toBe("succeeded");
    expect(file.reads).toBe(1);
    if (outcome.status === "succeeded") {
      expect(outcome.value.summary).toBe("boundary evidence");
      expect(outcome.value.contentBase64).toHaveLength(1_333_336);
    }
  });

  it("rejects 1,000,001 bytes without attempting a read", async () => {
    const file = new ObservedBlob([new Uint8Array(MAX_EVIDENCE_UPLOAD_BYTES + 1)]);

    expect(await prepareEvidenceUpload(file, "summary")).toEqual({
      status: "failed",
      error: { kind: "input", field: "file", reason: "too_large" },
    });
    expect(file.reads).toBe(0);
  });

  it("base64-encodes arbitrary binary exactly without a data URL prefix", async () => {
    const file = new Blob([new Uint8Array([0, 255, 128, 65, 10])]);
    const outcome = await prepareEvidenceUpload(file, "Binary sample", {
      kind: "log",
      privacyClass: "share_safe",
    });

    expect(outcome).toEqual({
      status: "succeeded",
      value: {
        kind: "log",
        summary: "Binary sample",
        mediaType: "application/octet-stream",
        contentBase64: "AP+AQQo=",
        privacyClass: "share_safe",
      },
    });
  });

  it("uses browser file metadata and MIME fallback", async () => {
    const file = new File(["hello"], " evidence.txt ", { type: "text/plain" });
    const outcome = await prepareEvidenceUpload(file, "note");

    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.value.filename).toBe("evidence.txt");
      expect(outcome.value.mediaType).toBe("text/plain");
      expect(outcome.value.kind).toBe("attachment");
    }
  });

  it("bounds unreadable blobs without exposing the thrown error", async () => {
    const outcome = await prepareEvidenceUpload(new UnreadableBlob(["secret"]), "note");
    expect(outcome).toEqual({
      status: "failed",
      error: { kind: "input", field: "file", reason: "unreadable" },
    });
    expect(JSON.stringify(outcome)).not.toContain("private read failure");
  });
});
