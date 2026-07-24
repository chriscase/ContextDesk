import { useEffect, useId, useState } from "react";
import {
  hostCancelS3WorkspaceBackup,
  hostGetS3BackupSettings,
  hostListenS3BackupProgress,
  hostRunS3WorkspaceBackup,
  hostSaveS3BackupSettings,
  type S3BackupProgressDto,
  type S3BackupRunSummaryDto,
  type S3BackupSettingsDto,
} from "../../lib/host";
import { TextField, ToggleField } from "../forms";

const EMPTY: S3BackupSettingsDto = {
  enabled: false,
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  prefix: "",
  path_style: false,
  allow_private_network: false,
  credentials_present: false,
  keychain_service: "contextdesk-secrets",
  access_key_ref: "s3/default/access_key",
  secret_key_ref: "s3/default/secret_key",
  session_token_ref: "s3/default/session_token",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function phaseLabel(progress: S3BackupProgressDto): string {
  switch (progress.phase) {
    case "planning":
      return "Traversing, excluding, and hashing workspace files…";
    case "awaiting_confirmation":
      return "Waiting for trusted desktop confirmation…";
    case "uploaded":
      return `Uploaded ${progress.completed_files}/${progress.total_files} files (${formatBytes(progress.completed_bytes)}).`;
    case "skipped":
      return `Reused ${progress.completed_files}/${progress.total_files} planned files.`;
    case "manifest_published":
      return "Completed manifest published.";
  }
}

export function BackupSection() {
  const baseId = useId();
  const [settings, setSettings] = useState<S3BackupSettingsDto>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<S3BackupProgressDto | null>(null);
  const [result, setResult] = useState<S3BackupRunSummaryDto | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void hostGetS3BackupSettings()
      .then((value) => {
        if (active && value) setSettings(value);
      })
      .catch((error) => {
        if (active) setNote(errorText(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void hostListenS3BackupProgress((update) => {
      if (active) setProgress(update);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const update = <K extends keyof S3BackupSettingsDto>(
    key: K,
    value: S3BackupSettingsDto[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      const saved = await hostSaveS3BackupSettings({
        enabled: settings.enabled,
        endpoint: settings.endpoint,
        region: settings.region,
        bucket: settings.bucket,
        prefix: settings.prefix,
        path_style: settings.path_style,
        allow_private_network: settings.allow_private_network,
      });
      setSettings(saved);
      setNote("Destination saved after endpoint-policy validation.");
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const run = async (dryRun: boolean) => {
    setRunning(true);
    setResult(null);
    setProgress(null);
    setNote(null);
    try {
      const summary = await hostRunS3WorkspaceBackup(dryRun);
      setResult(summary);
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setRunning(false);
    }
  };

  const cancel = async () => {
    const requested = await hostCancelS3WorkspaceBackup();
    if (requested) setNote("Cancellation requested; waiting for the active operation to stop.");
  };

  return (
    <div>
      <p className="section-lead">
        Optional, explicitly triggered S3-compatible workspace backup/export.
        Local workspace roots remain authoritative.
      </p>
      <ToggleField
        id={`${baseId}-enabled`}
        label="Enable S3-compatible backup"
        hint="No network request occurs until you run a dry run or backup."
        checked={settings.enabled}
        onChange={(value) => update("enabled", value)}
      />
      <TextField
        id={`${baseId}-endpoint`}
        label="Endpoint"
        value={settings.endpoint}
        placeholder="https://s3.example.com"
        disabled={loading || running}
        onChange={(event) => update("endpoint", event.target.value)}
        hint="HTTPS is the default. Private/local endpoints require the explicit opt-in below; metadata and link-local targets remain blocked."
      />
      <TextField
        id={`${baseId}-region`}
        label="Region"
        value={settings.region}
        disabled={loading || running}
        onChange={(event) => update("region", event.target.value)}
      />
      <TextField
        id={`${baseId}-bucket`}
        label="Bucket"
        value={settings.bucket}
        disabled={loading || running}
        onChange={(event) => update("bucket", event.target.value)}
      />
      <TextField
        id={`${baseId}-prefix`}
        label="Prefix (optional)"
        value={settings.prefix}
        disabled={loading || running}
        onChange={(event) => update("prefix", event.target.value)}
        hint="ContextDesk writes a stable, versioned namespace below this prefix and never deletes remote objects in Phase A."
      />
      <ToggleField
        id={`${baseId}-path-style`}
        label="Use path-style requests"
        hint="Usually required for MinIO-compatible services."
        checked={settings.path_style}
        disabled={running}
        onChange={(value) => update("path_style", value)}
      />
      <ToggleField
        id={`${baseId}-private`}
        label="Allow an explicitly configured private-network endpoint"
        hint="Does not permit cloud metadata or link-local destinations."
        checked={settings.allow_private_network}
        disabled={running}
        onChange={(value) => update("allow_private_network", value)}
      />

      <div className="card">
        <strong>
          Credentials: {settings.credentials_present ? "present in OS keychain" : "not found"}
        </strong>
        <p className="field__hint">
          Raw credentials never cross the webview. Provision entries in the OS
          credential manager under service <span className="mono">{settings.keychain_service}</span>{" "}
          with accounts <span className="mono">{settings.access_key_ref}</span> and{" "}
          <span className="mono">{settings.secret_key_ref}</span>. The optional session-token
          account is <span className="mono">{settings.session_token_ref}</span>.
        </p>
      </div>

      <div className="workspace-root-actions">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={loading || saving || running}
          onClick={() => void save()}
        >
          {saving ? "Validating…" : "Save destination"}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!settings.enabled || running || saving}
          onClick={() => void run(true)}
        >
          Dry run…
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!settings.enabled || running || saving || !settings.credentials_present}
          onClick={() => void run(false)}
        >
          Back up workspace…
        </button>
        {running ? (
          <button type="button" className="btn btn--danger" onClick={() => void cancel()}>
            Cancel backup
          </button>
        ) : null}
      </div>

      {progress ? (
        <p className="field__pending" role="status" aria-live="polite">
          {phaseLabel(progress)}
        </p>
      ) : null}
      {note ? (
        <p className="field__hint" role="status">
          {note}
        </p>
      ) : null}
      {result ? (
        <div className="card" aria-live="polite">
          <strong>Result: {result.status.replace("_", " ")}</strong>
          <p>
            Uploaded {result.uploaded_files} files ({formatBytes(result.uploaded_bytes)});
            reused {result.skipped_files} ({formatBytes(result.skipped_bytes)}); excluded{" "}
            {result.excluded_files} ({formatBytes(result.excluded_bytes)} known); failed{" "}
            {result.failed_files} ({formatBytes(result.failed_bytes)}).
          </p>
          {result.exclusion_reasons.length ? (
            <ul>
              {result.exclusion_reasons.map((item) => (
                <li key={item.reason}>
                  {item.reason.replaceAll("_", " ")}: {item.files} entries (
                  {formatBytes(item.bytes)} known)
                </li>
              ))}
            </ul>
          ) : null}
          {result.failure ? <p className="field__error">Failure: {result.failure}</p> : null}
        </div>
      ) : null}

      <p className="field__hint">
        Phase A has no restore, remote deletion, bidirectional sync, lifecycle
        management, or S3 index source. Excluded and unreadable files are reported;
        this is not a claim of a complete machine backup.
      </p>
    </div>
  );
}
