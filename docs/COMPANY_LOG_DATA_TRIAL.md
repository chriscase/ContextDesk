# Company log data trial

A short, non-technical procedure for trying ContextDesk with **your** company
logs. Use this when you want a go/no-go read on whether the product helps a real
investigation—without putting secrets or private data into bug reports.

This document is a trial runbook, not a blanket capability claim. ContextDesk
normalizes timestamps only when an explicit offset makes the instant
unambiguous and provides a bounded **Original (redacted)** inspector view.
Per-source timezone/year/DST policy and clock-skew diagnostics remain #670;
exact-template known-noise suppression is #671 Slice 1, while broader rule
types and lifecycle portability remain open. Synthetic Log Lab scenarios
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
| Rows / Original           | Use Compact tokens + Payload, switch presentations, and compare one long event with Original (redacted) | Presentation changes do not change evidence; provenance remains recoverable; normalization/redaction/truncation is disclosed |
| Bidirectional paging      | Scroll substantially down and back up                              | Older and newer pages load automatically without paging buttons or losing the logical position |
| Lanes / sources           | Open more than one source                                          | You can tell which file a line came from; basename collisions do not merge unrelated hosts |
| Timeline                  | Scroll/seek around the incident window                             | Order is usable; mixed or order-only data is not presented as perfect wall-clock certainty |
| Noise policy (disposable/reproducible corpus only while #671 is open) | Preview one reviewed repetitive template, confirm it, then exercise its lifecycle | Record whether preview counts/examples and rows/counts/facets/Timeline/Find/tools agree; do not interpret this trial as proof of unconditional reversibility |
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

## Trial an exact-template noise rule safely

Start with a repetitive template whose operational meaning you already know.
Select and inspect an event, choose **Suppress exact template…**, provide a
specific rationale, and review **Preview impact** before confirming. Record the
exact total, incremental hidden count, levels, source count, time span, and
redacted examples.

After confirmation, on a disposable or reproducible corpus:

1. compare rows, matched count, facets, Timeline, and the same Find;
2. run one tools-enabled linked question and verify it reports the pinned
   suppression revision and hidden count;
3. open a saved bookmark or direct evidence identity for a hidden event, use
   the temporary reveal, and restore the policy; and
4. attempt disable, re-enable, then remove on a disposable test rule and
   inspect the audit; record any refusal rather than assuming every terminal
   operation is guaranteed.

The event must never disappear from the raw corpus, source catalog, bounded
**Original (redacted)**, or direct evidence resolution. Do not infer that a
frequent template is noise, and do not use this Slice 1 control for a
source-wide or free-text exclusion.

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
| Rows / Original                       | pass / fail / skip — notes |
| Bidirectional paging                  | pass / fail / skip — notes |
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

- #671 remains open/partial. Slice 1 is exact-template, corpus-scoped,
  fail-closed, cross-process serialized, and directly proven across tool
  adapters.
- Literal #671 residuals also include source/service/host,
  level-plus-template, and reviewed-text predicates; rule editing and complete
  creator identity; Investigation/saved-view/package lifecycle; a global
  temporary include-suppressed action; a visible auditable tool
  include-suppressed option; suppression-specific 25k/100k and optional-1M
  measurements; baseline proposals; and larger-rule-set optimization.
- #690: each corpus is analyzed independently; cross-corpus learned application
  baselines are not yet shipped.
- #670: per-source timezone/year/DST configuration, subsecond provenance, and
  clock-skew correction remain incomplete.
- Tools-disabled profiles cannot perform a linked log investigation. Their
  honest refusal is expected behavior.
- Portable package v1 does not include corpus bookmarks, while durable
  Investigation records are persisted separately from the corpus. It also
  does not carry the corpus noise-policy sidecar.

## Related synthetic fixtures

For offline, deterministic coverage of the same themes (no company data):

| Scenario               | Import root                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| Timestamp diversity    | `fixtures/log-lab/scenarios/company-timestamp-diversity/import/` |
| Known noise vs signal  | `fixtures/log-lab/scenarios/company-known-noise/import/`         |
| Original-line fidelity | `fixtures/log-lab/scenarios/company-original-fidelity/import/`   |

Always import the `import/` child. Truth manifests under `truth/` are
evaluator-only and must not be selected as an import root.
