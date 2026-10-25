/** Synthetic, disposable SDK request-handler fixture with durable on-disk objects.
 * No network or real credentials. Faults occur below SDK retry middleware.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
interface ObjectRecord { key: string; bytes: string; metadata: Record<string, string>; contentType: string; etag: string }
export type CopyFault = "none" | "lost" | "lost_missing" | "truncated" | "empty" | "malformed" | "rejected" | "embedded" | "unclassified";
export class DurableS3ProtocolFixture {
  copies = 0;
  heads = 0;
  gets = 0;
  deletes: string[] = [];
  failProbes = false;
  fault: CopyFault = "none";
  private probeFailures = 0;
  constructor(readonly root: string, readonly bucket = "synthetic-bucket") {}
  private file(key: string) { return join(this.root, createHash("sha256").update(key).digest("hex") + ".json"); }
  async records(): Promise<ObjectRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return Promise.all((await readdir(this.root)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(this.root, name), "utf8")) as ObjectRecord));
  }
  async object(key: string): Promise<ObjectRecord | null> {
    try { return JSON.parse(await readFile(this.file(key), "utf8")) as ObjectRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async save(record: ObjectRecord) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.file(record.key), JSON.stringify(record), { mode: 0o600 });
  }
  readonly handler: NonNullable<S3ClientConfig["requestHandler"]> = {
    handle: async (request: { method: string; path: string; headers: Record<string, string>; query?: Record<string, string>; body?: unknown }) => {
      const key = decodeURIComponent(request.path).replace(new RegExp(`^/${this.bucket}/?`), "");
      const headers = request.headers;
      const xml = (body: string, statusCode = 200) => ({ response: { statusCode, headers: { "content-type": "application/xml" }, body: Readable.from([Buffer.from(body)]) } });
      const error = (code: string, status = 500) => xml(`<Error><Code>${code}</Code><Message>Synthetic fixture failure</Message></Error>`, status);
      if (request.method === "HEAD" && !key) return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
      if (request.method === "GET" && request.query?.["list-type"] === "2") {
        const prefix = request.query.prefix ?? "";
        const objects = (await this.records()).filter((item) => item.key.startsWith(prefix));
        const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
        return xml(`<ListBucketResult><Name>${this.bucket}</Name><IsTruncated>false</IsTruncated>${objects.map((item) => `<Contents><Key>${escape(item.key)}</Key><Size>${Buffer.from(item.bytes, "base64").length}</Size><ETag>${item.etag}</ETag></Contents>`).join("")}</ListBucketResult>`);
      }
      if (request.method === "PUT" && headers["x-amz-copy-source"]) {
        this.copies += 1;
        const sourceKey = decodeURIComponent(headers["x-amz-copy-source"]).replace(new RegExp(`^/?${this.bucket}/`), "");
        const source = await this.object(sourceKey);
        if (!source) return error("NoSuchKey", 404);
        const fault = this.fault;
        if (fault === "rejected") return error("ServiceUnavailable");
        if (fault === "embedded") return error("SlowDown", 200);
        if (fault === "unclassified") { this.failProbes = true; throw new Error("synthetic statusless provider failure"); }
        if (fault !== "lost_missing") {
          const metadata = headers["x-amz-metadata-directive"] === "REPLACE"
            ? Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith("x-amz-meta-")).map(([name, value]) => [name.slice(11), value]))
            : source.metadata;
          await this.save({ ...source, key, metadata, contentType: headers["content-type"] ?? source.contentType });
        }
        if (fault === "lost" || fault === "lost_missing") {
          if (fault === "lost") this.probeFailures = 3;
          this.fault = "none";
          throw Object.assign(new Error("synthetic lost copy response"), { code: "ECONNRESET" });
        }
        if (fault === "malformed") { this.failProbes = true; return xml("<CopyObjectResult><ETag>broken</CopyObjectResult>"); }
        if (fault === "empty") { this.failProbes = true; return xml(""); }
        if (fault === "truncated") {
          this.failProbes = true;
          const body = Readable.from((async function* () { yield Buffer.from("<CopyObjectResult><ETag>"); throw new Error("synthetic body truncation"); })());
          return { response: { statusCode: 200, headers: { "content-type": "application/xml" }, body } };
        }
        return xml(`<CopyObjectResult><ETag>${source.etag}</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></CopyObjectResult>`);
      }
      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        if (typeof request.body === "string" || request.body instanceof Uint8Array) chunks.push(Buffer.from(request.body));
        else if (request.body) for await (const chunk of request.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const metadata = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith("x-amz-meta-")).map(([name, value]) => [name.slice(11), value]));
        const etag = '"' + createHash("md5").update(bytes).digest("hex") + '"';
        await this.save({ key, bytes: bytes.toString("base64"), metadata, contentType: headers["content-type"] ?? "application/octet-stream", etag });
        return { response: { statusCode: 200, headers: { etag }, body: Readable.from([]) } };
      }
      if (request.method === "DELETE") {
        this.deletes.push(key);
        try { await unlink(this.file(key)); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; }
        return { response: { statusCode: 204, headers: {}, body: Readable.from([]) } };
      }
      if (request.method === "HEAD") {
        this.heads += 1;
        if (key.includes("blobs/") && (this.failProbes || this.probeFailures-- > 0)) return error("ServiceUnavailable");
      }
      if (request.method === "GET") this.gets += 1;
      const object = await this.object(key);
      if (!object) return error("NoSuchKey", 404);
      if (headers["if-match"] && headers["if-match"] !== object.etag) return error("PreconditionFailed", 412);
      const bytes = Buffer.from(object.bytes, "base64");
      const outHeaders: Record<string, string> = { etag: object.etag, "content-length": String(bytes.length), "content-type": object.contentType,
        ...Object.fromEntries(Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])) };
      return { response: { statusCode: 200, headers: outHeaders, body: Readable.from(request.method === "HEAD" ? [] : [bytes]) } };
    },
  };
}
