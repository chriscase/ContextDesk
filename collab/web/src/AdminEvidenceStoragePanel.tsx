import {
  parseEvidenceStorageStatus,
  type EvidenceStorageStatusV1,
} from "@cd-collab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${Math.round(value / (1024 * 1024))} MiB`;
}

function endpointLabel(status: EvidenceStorageStatusV1): string {
  if (status.provider !== "s3" || status.endpoint === null) return "Local filesystem volume";
  return status.endpoint;
}

export function AdminEvidenceStoragePanel() {
  const [status, setStatus] = useState<EvidenceStorageStatusV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setFailure("");
    try {
      const response = await protectedApiFetch("/api/admin/evidence-storage", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("storage status unavailable");
      const parsed = parseEvidenceStorageStatus(await response.json());
      if (requestId !== requestIdRef.current) return;
      setStatus(parsed);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus(null);
      setFailure("Evidence storage status could not be validated. No configuration details are shown.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  const stateLabel = status?.state === "ready" ? "Ready" : status?.state === "unavailable" ? "Unavailable" : "Not reported";
  return (
    <section className="administration__panel admin-storage" aria-labelledby="admin-storage-title">
      <div className="administration__panel-heading">
        <div>
          <h3 id="admin-storage-title" ref={headingRef} tabIndex={-1}>Evidence storage</h3>
          <p>Confirm where evidence bytes live and whether the server can reach the configured provider. Secrets and control paths never appear here.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Checking…" : "Check again"}
        </button>
      </div>
      {loading && !status ? <p role="status">Checking evidence storage…</p> : null}
      {failure ? <p className="administration__message administration__message--error" role="alert">{failure}</p> : null}
      {status ? (
        <>
          <div className={`admin-storage__state admin-storage__state--${status.state}`} role="status">
            <span className="admin-storage__state-dot" aria-hidden="true" />
            <strong>{stateLabel}</strong>
            <span>Last checked {new Date(status.checkedAt).toLocaleString()}</span>
          </div>
          <dl className="admin-storage__facts">
            <div><dt>Evidence provider</dt><dd>{status.provider === "s3" ? "S3-compatible object storage" : "Local filesystem"}</dd></div>
            <div><dt>Database</dt><dd>{status.database === "postgres" ? "PostgreSQL" : "SQLite"}</dd></div>
            <div><dt>Connection</dt><dd><code>{endpointLabel(status)}</code></dd></div>
            {status.provider === "s3" ? <>
              <div><dt>Region</dt><dd><code>{status.region}</code></dd></div>
              <div><dt>Bucket</dt><dd><code>{status.bucket}</code></dd></div>
              <div><dt>Prefix</dt><dd><code>{status.prefix || "(bucket root)"}</code></dd></div>
              <div><dt>Credential mode</dt><dd>{status.credentialsMode === "default_chain" ? "Server credential chain" : "Static server credentials"}</dd></div>
              <div><dt>Request timeout</dt><dd>{status.requestTimeoutMs === null ? "Not reported" : `${status.requestTimeoutMs.toLocaleString()} ms`}</dd></div>
            </> : null}
            <div><dt>Maximum upload</dt><dd>{formatBytes(status.maxUploadBytes)}</dd></div>
          </dl>
          <p className="admin-storage__boundary" role="note">
            The browser talks only to the ContextDesk server. Authorization, checksums, audit history, and provider credentials stay server-side.
          </p>
        </>
      ) : null}
    </section>
  );
}
