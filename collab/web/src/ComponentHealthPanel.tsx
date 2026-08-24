import {
  parseComponentHealthResponse,
  type ComponentHealthComponentV1,
  type ComponentHealthResponseV1,
} from "@cd-collab/contracts/admin";
import { useEffect, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";

function value(value: string | null): string {
  return value ?? "Not reported";
}

function componentDetails(component: ComponentHealthComponentV1): string {
  return component.reportStatus === "reported"
    ? component.source === "synthetic_fixture"
      ? "Synthetic fixture"
      : "Runtime report"
    : "Not reported";
}

export function ComponentHealthPanel() {
  const [health, setHealth] = useState<ComponentHealthResponseV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void protectedApiFetch("/api/admin/component-health", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("component health unavailable");
        const parsed = parseComponentHealthResponse(await response.json());
        if (!active) return;
        setHealth(parsed);
        setError("");
      })
      .catch(() => {
        if (!active) return;
        setHealth(null);
        setError("Component health could not be validated. No component identity is shown.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="administration__panel administration__health" aria-labelledby="component-health-title">
      <div className="administration__panel-heading">
        <div>
          <h3 id="component-health-title">Component health</h3>
          <p>Read-only release identity and protocol state. Compatibility is never inferred across components.</p>
        </div>
      </div>
      {loading ? <p role="status">Loading component health…</p> : null}
      {error ? <p className="administration__message administration__message--error" role="status">{error}</p> : null}
      {health ? (
        <>
          <p className="administration__health-mode" role="note">
            {health.dataMode === "synthetic_fixture"
              ? "Synthetic fixture data — this is not live desktop, CLI, or host telemetry."
              : "Runtime report — fields remain not reported until a component supplies them."}
          </p>
          <div className="administration__health-table-wrap">
            <table className="administration__table administration__health-table">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Version / commit</th>
                  <th scope="col">Protocol</th>
                  <th scope="col">Storage migration</th>
                  <th scope="col">Compatibility</th>
                  <th scope="col">Update</th>
                </tr>
              </thead>
              <tbody>
                {health.components.map((component) => (
                  <tr key={component.id}>
                    <th scope="row">
                      {component.label}
                      <span className="administration__health-subtle">{componentDetails(component)}</span>
                    </th>
                    <td>
                      <span>{value(component.version)}</span>
                      <span className="administration__health-subtle">Commit: {value(component.commit)}</span>
                    </td>
                    <td>{component.protocol ? `${component.protocol.name} ${component.protocol.version}` : "Not reported"}</td>
                    <td>
                      <span>{component.storageMigration.state}</span>
                      {component.storageMigration.current || component.storageMigration.target ? (
                        <span className="administration__health-subtle">
                          {value(component.storageMigration.current)} → {value(component.storageMigration.target)}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span>{component.compatibility.status}</span>
                      <span className="administration__health-subtle">{component.compatibility.detail}</span>
                    </td>
                    <td>
                      <span>{component.update.state}</span>
                      {component.update.targetVersion ? (
                        <span className="administration__health-subtle">Target: {component.update.targetVersion}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="administration__health-notices">
            {health.notices.map((notice) => <li key={notice}>{notice}</li>)}
          </ul>
        </>
      ) : null}
    </section>
  );
}
