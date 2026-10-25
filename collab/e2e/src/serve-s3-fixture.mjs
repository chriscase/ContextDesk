/** Executable test-only joined app/Runtime/SDK fixture. No production fault endpoints. */
import { watch } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { ConfiguredRetryStrategy } from "@smithy/core/retry";
import { createEvidenceStore } from "../../server/src/evidence/provider.ts";
import { loadEvidenceS3Credentials } from "../../server/src/evidence/s3-secrets.ts";
import { loadEvidenceStorageSettings } from "../../server/src/evidence/s3-settings.ts";
import { DurableS3ProtocolFixture } from "../../server/src/evidence/testkit/s3-protocol-fixture.ts";
import { serveFixture } from "./serve-fixture.ts";

const control = process.env.COLLAB_S3_REPORT_DIR;
if (!control) throw new Error("COLLAB_S3_REPORT_DIR must name a disposable control directory");
await mkdir(control, { recursive: true, mode: 0o700 });
let provider;
let references = async () => new Set();
let recover;
let revision = 0;
let tail = Promise.resolve();
function report() {
  tail = tail.then(async () => {
    const objects = await provider.records();
    const snapshot = { revision: ++revision, copies: provider.copies, heads: provider.heads, gets: provider.gets,
      pending: objects.filter((item) => item.key.includes("/.pending/")).length,
      canonical: objects.filter((item) => item.key.includes("/blobs/")).length,
      referenced: (await references()).size,
      canonicalDeletes: provider.deletes.filter((key) => key.includes("/blobs/")).length };
    await writeFile(join(control, "report.next"), JSON.stringify(snapshot), { mode: 0o600 });
    await rename(join(control, "report.next"), join(control, "report.json"));
  });
  return tail;
}
await serveFixture({
  createStore: async (root) => {
    provider = new DurableS3ProtocolFixture(join(root, "protocol-objects"));
    provider.fault = "lost";
    const underlying = provider.handler;
    const handler = { handle: async (...args) => { try { return await underlying.handle(...args); } finally { await report(); } } };
    const env = { COLLAB_EVIDENCE_PROVIDER: "s3", COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
      COLLAB_EVIDENCE_S3_REGION: "us-east-1", COLLAB_EVIDENCE_S3_BUCKET: provider.bucket,
      COLLAB_EVIDENCE_S3_PREFIX: "evidence", COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
      COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: "SYNTHETICACCESS", COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: "synthetic-secret" };
    const store = createEvidenceStore({ settings: loadEvidenceStorageSettings(env, { controlRoot: root, storage: "postgres" }),
      credentials: loadEvidenceS3Credentials(env), createRequestHandler: () => handler,
      createS3Client: (config) => new S3Client({ ...config, retryStrategy: new ConfiguredRetryStrategy(3, 0) }) });
    store.addReferencedContentHashSource(() => references());
    recover = () => store.recoverUnreferencedWrites();
    const publicMethods = ["put", "stage", "stageStream", "get", "head", "openRead", "verify", "putFileServerReference", "getFileServerReference", "verifyFileServerReference", "abandonFileServerReference", "restoreFileServerReference", "ping", "beginWriteBatch", "recoverUnreferencedWrites"];
    const publicPrototype = Object.fromEntries(publicMethods.map((name) => [name, (...args) => store[name](...args)]));
    const facade = Object.create(publicPrototype);
    facade.writeCoordination = store.writeCoordination;
    // Registration is synchronous; it must not be changed into an async wrapper.
    facade.addReferencedContentHashSource = (loader) => store.addReferencedContentHashSource(loader);
    return facade;
  },
  onCasesReady: (cases) => { references = () => cases.listReferencedContentHashes(); },
});
watch(control, async (_, filename) => {
  if (filename !== "recover.request") return;
  try {
    const nonce = await readFile(join(control, filename), "utf8");
    await recover?.(); await report();
    await writeFile(join(control, "recover.done"), nonce, { mode: 0o600 });
  } catch { await writeFile(join(control, "recover.failed"), "synthetic recovery failed", { mode: 0o600 }); }
});
