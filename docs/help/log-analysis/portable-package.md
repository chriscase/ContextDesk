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

Packages may still contain sensitive redacted analysis; share only with trusted peers.

See also [How log analysis works](log-analysis-pipeline.md).
