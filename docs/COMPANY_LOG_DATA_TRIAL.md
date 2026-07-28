# Company log data trial

A short, non-technical procedure for trying ContextDesk with **your** company
logs. Use this when you want a go/no-go read on whether the product helps a real
investigation—without putting secrets or private data into bug reports.

This document is a trial runbook. It does **not** claim that timestamp
normalization, known-noise suppression, or an Original (redacted) view already
ship. Those are future product work (see #670, #671, #673). Synthetic Log Lab
scenarios under `fixtures/log-lab/scenarios/company-*` encode the same concerns
for automated tests; prefer those for offline proof, and this runbook for a
live company-data session.

## Before you start

1. **Copy a small, approved sample.** Work from a dedicated copy of logs, not
   production storage. Prefer one incident window or one service directory.
2. **Scope tightly.** A few files and a few thousand events is enough for a
   first trial. Larger corpora can wait until the small sample looks useful.
3. **Handle secrets per company policy.** Remove, mask, or replace credentials,
   tokens, customer identifiers, and private hostnames **before** import when
   policy requires it. Do not paste secrets into chat, screenshots, or issues.
4. **Write down assumptions** (a sticky note is fine):
   - source formats you expect (JSON, logfmt, syslog, plain, mixed);
   - timezone or offset you believe the sources use;
   - approximate incident start/end in wall time;
   - which hosts/services matter for the story.

## Import

1. In ContextDesk, open **Logs → Import**.
2. Select **only the directory that contains the log files** you intend to
   analyze. Do **not** select a parent that also holds evaluator notes, truth
   files, or private side documents.
3. After import finishes, record:
   - file count and event count (or “unknown / partial”);
   - any failed, excluded, binary, or empty files;
   - time-quality labels if shown (wall / order-only / mixed).
4. If counts look wrong, stop and fix the sample or import root before drawing
   product conclusions.

## Exercise the product

Work through each row. Mark pass / fail / skip and a one-line note.

| Area | What to try | Pass if |
| --- | --- | --- |
| Find | Search for a known incident token (request id, error string, host) | The expected line is findable without false “empty” results when the token exists |
| Filter | Filter by level, service, or source if available | Results match what you can verify in the raw files |
| Lanes / sources | Open more than one source | You can tell which file a line came from; basename collisions do not merge unrelated hosts |
| Timeline | Scroll/seek around the incident window | Order is usable; mixed or order-only data is not presented as perfect wall-clock certainty |
| Bookmarks / investigation | Save 2–3 important events | You can reopen them later in the same session |
| Linked chat | Ask a narrow question with tools enabled if your build supports it | Answers that cite events can be checked against the source lines |

## AI and evidence

- Record the **provider/model** you used and whether **tools** were enabled.
- Treat every AI conclusion as a **hypothesis** until you open the cited source
  lines (or confirm the claim is unsupported).
- Prefer questions like “which events mention `req-…`?” over “what caused the
  outage?” until retrieval looks trustworthy.
- If the model invents timestamps, hosts, or stack frames that are not in the
  logs, note that as a failure—even if the prose sounds confident.

## What to capture (safe)

For each notable issue, write:

- what you did;
- what you expected;
- what you saw;
- **synthetic or redacted** snippets only—never real secrets, customer data,
  private paths, or internal hostnames in screenshots or GitHub issues.

Useful categories: false positives, missed events, parse mistakes, timestamp
ambiguity, UI friction, performance (rough: “felt fine” / “slow after N
events”).

## Go / no-go checklist

Check each box only when true for **this** sample and build.

- [ ] Import completed for the intended directory only
- [ ] Event/file counts are believable vs. the raw sample
- [ ] At least one known incident token is findable
- [ ] Source provenance is clear enough to trust multi-file stories
- [ ] Time display does not over-claim when timestamps are missing or mixed
- [ ] Bookmarks (or equivalent) preserve important events in-session
- [ ] Chat/tools (if used) cite checkable evidence more often than they invent
- [ ] No secrets or private data left in notes, screenshots, or tickets

**Go** if the checklist is mostly true and remaining gaps are documented.
**No-go** if import is untrustworthy, provenance is wrong, or AI routinely
fabricates evidence you cannot correct from the UI.

## Results table (copy per trial)

| Field | Value |
| --- | --- |
| Date | |
| Build / version | |
| Sample description (no secrets) | |
| Approx. files / events | |
| Formats / timezone notes | |
| Provider / model | |
| Tools enabled? | Y / N |
| Find | pass / fail / skip — notes |
| Filter | pass / fail / skip — notes |
| Lanes / sources | pass / fail / skip — notes |
| Timeline | pass / fail / skip — notes |
| Bookmarks / investigation | pass / fail / skip — notes |
| Linked chat | pass / fail / skip — notes |
| Timestamp issues seen | |
| Noise / clutter issues seen | |
| Original-line / redaction issues seen | |
| Performance notes | |
| Go / no-go | |
| Follow-ups (issue ids, if any) | |

## Related synthetic fixtures

For offline, deterministic coverage of the same themes (no company data):

| Scenario | Import root |
| --- | --- |
| Timestamp diversity | `fixtures/log-lab/scenarios/company-timestamp-diversity/import/` |
| Known noise vs signal | `fixtures/log-lab/scenarios/company-known-noise/import/` |
| Original-line fidelity | `fixtures/log-lab/scenarios/company-original-fidelity/import/` |

Always import the `import/` child. Truth manifests under `truth/` are
evaluator-only and must not be selected as an import root.
