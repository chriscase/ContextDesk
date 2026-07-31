---
id: log-portable-package
title: Share a log analysis package
summary: Export a finished corpus so another ContextDesk user can import it without re-running ingest.
section: log-analysis
tags:
  - logs
  - package
  - export
  - import
order: 20
related:
  - log-analysis-pipeline
  - permission-tiers
---

# Share a log analysis package

After SoftWrite ingest, open **Logs**, select the corpus, and choose **Export package…**.  
Peers use **Import package…** (SoftWrite Accept). Import always creates a **new** local corpus id.

## Versioning

Packages declare `format_version` and `min_reader_version`.  
If the package is **newer** than this build, ContextDesk refuses import with a clear message — upgrade or re-export as v1.

An **Incident Evidence Bundle** (`contextdesk.incident_evidence.v1`) is a
different, producer-facing interchange format for raw logs and optional metrics.
See help://incident-evidence-bundle. Do not treat a portable analysis package as
a substitute for an evidence bundle, or the reverse.

Packages may still contain sensitive redacted analysis; share only with trusted
peers. Portable package v1 exports corpus events/templates but does not include
bookmarks, durable Investigation records, or linked-chat history. Import
creates a new corpus identity, so those artifacts do not silently transfer.

See also [How log analysis works](help://log-analysis-pipeline).
