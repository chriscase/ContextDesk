#!/usr/bin/env python3
"""Minimal Python sketch for Incident Evidence Bundle v1 (directory form)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def sha256_file(path: Path) -> tuple[int, str]:
    h = hashlib.sha256()
    total = 0
    with path.open("rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            total += len(chunk)
            h.update(chunk)
    return total, h.hexdigest()


def main() -> None:
    root = Path("./incident-evidence-out")
    log_rel = "logs/app.log"
    log_path = root / log_rel
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_bytes(b"2024-01-15T12:00:00Z INFO synthetic\n")
    bytes_, digest = sha256_file(log_path)

    # Optional operational-metrics v1 document (reuse series schema; do not invent another).
    metrics_rel = "metrics/operational-metrics.v1.json"
    metrics_path = root / metrics_rel
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    metrics = {
        "schemaVersion": 1,
        "id": "example-perf",
        "name": "Example performance",
        "series": [
            {
                "id": "cpu-percent",
                "name": "CPU",
                "unit": "%",
                "timeQuality": "wall",
                "provenance": {
                    "source": "synthetic/example-performance-monitor",
                    "collector": "example-python-collector",
                },
                "points": [
                    {"timestamp": 1705312800, "value": 20},
                    {"timestamp": 1705312860, "value": 35},
                ],
            }
        ],
    }
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    m_bytes, m_digest = sha256_file(metrics_path)

    manifest = {
        "schemaId": "contextdesk.incident_evidence.v1",
        "minReaderVersion": 1,
        "bundleId": "example-python-bundle",
        "createdAt": "2024-01-15T12:05:00Z",
        "producer": {"name": "example-python-collector", "version": "0.1.0"},
        "privacy": {
            "redactionDeclared": True,
            "containsCredentials": False,
            "containsPii": False,
        },
        "timeBasis": {"timezone": "UTC", "timezoneResolved": True},
        "components": [
            {
                "id": "log-app",
                "role": "log",
                "path": log_rel,
                "mediaType": "text/plain",
                "bytes": bytes_,
                "sha256": digest,
                "sourceLabel": "app",
            },
            {
                "id": "metrics-perf",
                "role": "operational_metrics",
                "path": metrics_rel,
                "mediaType": "application/json",
                "bytes": m_bytes,
                "sha256": m_digest,
            },
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {root}")


if __name__ == "__main__":
    main()
