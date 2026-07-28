# Company log data trial

A short, non-technical procedure for trying ContextDesk with **your** company
logs. Use this when you want a go/no-go read on whether the product helps a real
investigation—without putting secrets or private data into bug reports.

This document is a trial runbook, not a blanket capability claim. ContextDesk
normalizes timestamps only when an explicit offset makes the instant
unambiguous and provides a bounded **Original (redacted)** inspector view.
Per-source timezone/year/DST policy and clock-skew diagnostics remain #670;
durable known-noise suppression remains #671. Synthetic Log Lab scenarios
under `fixtures/log-lab/scenarios/company-*` encode the same concerns for
automated tests; prefer those for offline proof, and this runbook for a live
company-data session.

## Before you start

1. **Record the promoted build.** Use the packaged build produced from current
   `main` and record its commit SHA.
2. **Copy a small, approved sample.** Work from a dedicated copy of logs, not
   production storage. Prefer one incident window or one service directory.
3. **Scope tightly.** Start with roughly 2–10 files and 1,000–25,000 events.
   Larger corpora can wait until the small sample looks useful.
4. **Handle secrets per company policy.** Remove, mask, or replace credentials,
   tokens, customer identifiers, and private hostnames **before** import when
   policy requires it. Built-in redaction reduces risk; it is not a guarantee.
   Do not paste secrets into chat, screenshots, or issues.
5. **Approve storage and model egress.** ContextDesk stores the imported corpus,
   linked-chat history, and durable Investigation records locally. A remote
   model provider can receive the prompt, bounded chat history, and bounded
   redacted tool evidence. Use a loopback local-model profile when evidence
   must not leave the machine.
6. **Write down expected controls** (a sticky note is fine):
   - source formats you expect (JSON, logfmt, syslog, plain, mixed);
   - timezone or offset you believe the sources use;
   - approximate incident start/end in wall time;
   - which hosts/services matter for the story;
   - expected file/event counts;
   - one known incident token, one ordinary event, and one token known to be
     absent.

## Import

1. In ContextDesk, open **Logs → Import**.
2. Select **only the directory that contains the log files** you intend to
   analyze. Do **not** select a parent that also holds evaluator notes, truth
   files, or private side documents.
3. After import finishes, record:
   - discovered/imported file and event counts (or “unknown / partial”);
   - any failed, excluded, or ignored files;
   - Source and Corpus sizes;
   - Analysis mode (Keyword-only, Deferred, Partial, or Complete);
   - any **Partial corpus** explanation;
   - time-quality labels if shown (wall / order-only / mixed).
4. If counts look wrong or an omission is unexplained, stop and fix the sample
   or import root before drawing product conclusions. Keyword-only analysis is
   still usable; local re-analysis is optional when semantic template search is
   needed.

## Exercise the product

Work through each row. Mark pass / fail / skip and a one-line note.

| Area                      | What to try                                                        | Pass if                                                                                    |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Find                      | Search for a known incident token (request id, error string, host) | The expected line is findable without false “empty” results when the token exists          |
| Filter                    | Filter by level, service, or source if available                   | Results match what you can verify in the raw files                                         |
| Lanes / sources           | Open more than one source                                          | You can tell which file a line came from; basename collisions do not merge unrelated hosts |
| Timeline                  | Scroll/seek around the incident window                             | Order is usable; mixed or order-only data is not presented as perfect wall-clock certainty |
| Bookmarks / investigation | Save 2–3 exact events and one finding; close and reopen Explorer    | Saved evidence resolves to the same events or visibly reports stale/missing identities     |
| Linked chat               | Ask a narrow question using a model marked “linked tools available” | A real log tool runs and every cited `seq` and `source` resolves to the claimed evidence    |

## AI and evidence

- Record the **provider/model** you used and whether the selected model says
  **linked tools available**.
- A model marked **linked tools unavailable** is expected to stop before
  contacting the provider. It cannot pass a grounded linked-chat trial.
- Treat every AI conclusion as a **hypothesis** until you open the cited source
  lines (or confirm the claim is unsupported).
- Prefer questions like “which events mention `req-…`?” over “what caused the
  outage?” until retrieval looks trustworthy.
- If the model invents timestamps, hosts, or stack frames that are not in the
  logs, note that as a failure—even if the prose sounds confident.
- Navigation proposals must remain inert until you choose to apply them.
- Open an ordinary main-screen chat and ask about the corpus. It must not
  silently inherit Log Explorer context.

A useful first linked-chat prompt is:

> Without assuming a cause, identify the three most suspicious patterns in
> these logs. For each, distinguish observation from inference, cite the exact
> `seq` and `source`, and suggest a safe view I can open.

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
- [ ] Bookmarks and Investigation material survive close/reopen and resolve
      exact evidence
- [ ] A tools-enabled linked chat visibly uses a bounded log tool and every
      material citation resolves correctly
- [ ] An ordinary chat does not silently inherit the corpus
- [ ] No secrets or private data left in notes, screenshots, or tickets

**Go** only when every applicable trust and privacy item above passes.

**No-go** if there is an unexplained import mismatch or omission, wrong source
provenance, unredacted sensitive content, fabricated timestamp/alignment
certainty, a linked-chat conclusion without successful log-tool evidence, a
citation that resolves to the wrong event, or important evidence that cannot be
recovered after reopening.

Cosmetic friction, Keyword-only analysis, or a documented unsupported format
can be a conditional-go item when the demo avoids overclaiming it.

Discarding a corpus does not guarantee removal of separately persisted
Investigation records or linked-chat history. Use an approved disposable VM or
OS profile when policy requires a guaranteed clean environment.

## Results table (copy per trial)

| Field                                 | Value                      |
| ------------------------------------- | -------------------------- |
| Date                                  |                            |
| Build / version                       |                            |
| Sample description (no secrets)       |                            |
| Approx. files / events                |                            |
| Formats / timezone notes              |                            |
| Provider / model                      |                            |
| Tools enabled?                        | Y / N                      |
| Find                                  | pass / fail / skip — notes |
| Filter                                | pass / fail / skip — notes |
| Lanes / sources                       | pass / fail / skip — notes |
| Timeline                              | pass / fail / skip — notes |
| Bookmarks / investigation             | pass / fail / skip — notes |
| Linked chat                           | pass / fail / skip — notes |
| Timestamp issues seen                 |                            |
| Noise / clutter issues seen           |                            |
| Original-line / redaction issues seen |                            |
| Performance notes                     |                            |
| Go / no-go                            |                            |
| Follow-ups (issue ids, if any)        |                            |

## Known trial boundaries

- #671: filters are temporary; durable, auditable noise-suppression rules are
  not yet shipped.
- #690: each corpus is analyzed independently; cross-corpus learned application
  baselines are not yet shipped.
- #670: per-source timezone/year/DST configuration, subsecond provenance, and
  clock-skew correction remain incomplete.
- Tools-disabled profiles cannot perform a linked log investigation. Their
  honest refusal is expected behavior.
- Portable package v1 does not include corpus bookmarks, while durable
  Investigation records are persisted separately from the corpus.

## Related synthetic fixtures

For offline, deterministic coverage of the same themes (no company data):

| Scenario               | Import root                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| Timestamp diversity    | `fixtures/log-lab/scenarios/company-timestamp-diversity/import/` |
| Known noise vs signal  | `fixtures/log-lab/scenarios/company-known-noise/import/`         |
| Original-line fidelity | `fixtures/log-lab/scenarios/company-original-fidelity/import/`   |

Always import the `import/` child. Truth manifests under `truth/` are
evaluator-only and must not be selected as an import root.
