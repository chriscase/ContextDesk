# Activity visibility GUI demo

## Purpose and safety boundary

This runbook demonstrates ContextDesk's observable chat, import, evidence, and
investigation flow with public synthetic data. Use only the repository's
`fixtures/log-lab/scenarios/checkout-cascade/import/` directory or its public
`fixtures/log-lab/archives/checkout-cascade.zip`. Never select a sibling
`truth/` directory: truth files are evaluator-only and must not become model
context or customer evidence.

Run the exact build under review. Use a configured test provider, but do not
show credentials, authorization headers, private prompts, or private corpora
on screen. Developer detail is redacted and bounded, not guaranteed anonymous.

## Prepare a repeatable corpus

1. Open **Logs** and choose **Import logs…**.
2. Select either the exact `checkout-cascade/import/` folder or
   `checkout-cascade.zip` above. Accept the host write confirmation.
3. Verify the completed import reports **35 events**, **6 files**, and wall
   clock time. A different count is a failed demo setup, not a result to talk
   past.
4. Select the new corpus and open **Explorer**.

The Activity import ledger should show the host-reported inclusion, parsing,
redaction contract, timestamp quality, indexing, and optional hook result.
Call out the labels, not colors:

- deterministic host work is exact local processing;
- repeatable heuristic means the same rule can be rerun, not that it is proof;
- model/external work is probabilistic;
- a user decision is human authority.

If embedding is disabled, deferred, or unavailable, the honest result is
**Keyword analysis** or **None ran during this import**. Do not claim a model
ran. If time is mixed, order-only, or unresolved, demonstrate that label and
the review path instead of implying a wall-clock timeline.

## Show the four display modes

Open the **Activity** control in ordinary chat, Logs, or Explorer and visit the
four modes in order. The hidden mode is labelled **Off** in the current UI:

1. **Off** hides all ContextDesk activity presentation. It does not change the
   work the application performs.
2. **Compact** shows one quiet summary per turn, with detail on request.
3. **Drawer** opens detail in an overlay while keeping the primary workspace
   clear.
4. **Docked** keeps the activity rail beside the work. On a narrow window it
   honestly falls back to Drawer instead of crushing the log or chat surface.

The display preference is shared across the app. Leave it on **Docked** for a
wide-screen demo or **Drawer** for a normal laptop screen.

## Ordinary chat with Developer detail

1. In the main chat, open **Activity** and turn **Developer detail · On**.
2. Ask: `What context do you have for this conversation, and what is still unknown?`
3. While the turn runs, open **Technical detail** and expand several rows.
4. Show the context-provenance sequence before the provider request: system,
   selected history, compaction, ambient memory, session packs, pinned skills,
   connectors, linked evidence, viewport, tools, budget, and transition.
5. Point out `not present` / `not reported`, character **estimates**, authority
   labels, and explicit retained/omitted counts. These are preferable to
   invented zeros.
6. Turn Developer detail **Off**. It is process-lifetime only, resets Off on
   restart, and turning it off stops new sensitive detail immediately, even
   for an in-flight turn. The ordinary summary can remain visible.

Developer detail may contain redacted conversation or source content. Do not
enable it while displaying sensitive material to an audience.

## Linked-log investigation and evidence lanes

1. Link chat to the imported `checkout-cascade` corpus.
2. Ask: `Investigate job-7f3a. What initiated the checkout failures, what were the downstream symptoms, and what evidence would disprove your explanation? Cite the relevant events.`
3. In Activity, show the provider round, offered and executed log tools,
   grounding status, linked-evidence provenance, and any honest failure or
   withheld-answer reason. A response without host-resolvable citations is not
   a successful grounded demo.
4. Open **Evidence · N** on the grounded answer. Select only host-verified log
   events; use **Select all log** if appropriate.
5. Choose **One lane**, **Group related**, or **One source per lane**. The last
   two may create up to four customer-evidence lanes. Review the deterministic
   assignment preview; pin, reorder, or remove a proposed lane if useful.
6. Choose **Show in Explorer**. If occupied lanes would change, review the
   exact preview and confirm; cancelling must keep the prior layout. More than
   four source groups fails closed rather than silently omitting evidence.
7. Verify the Explorer opens the cited corpus and highlights the resolved
   events in 1–4 **Customer evidence** lanes. ContextDesk Activity remains a
   separate group and never counts as corpus evidence.
8. Return to **Evidence · N**, choose **Add to investigation**, review the exact
   corpus/event/revision preview, select **Confirm add**, then **Write to
   investigation**. Cancelling or undoing before the write must make no change.

Useful follow-up turns are:

- `Which evidence supports configuration change pool-max-4, and which entries are merely secondary symptoms?`
- `Challenge the current explanation using the healthy /health traffic and certificate-rotation entries.`
- `Summarize the investigation so far, preserving uncertainty and linking each conclusion to evidence.`

## Honest fallback checklist

- **No Activity record:** show `not recorded by host`; renderer observations
  are fallback-only and must not be presented as a complete host trace.
- **No citations or failed host resolution:** do not improvise evidence lanes
  or add prose-derived claims to an investigation.
- **Provider or tool failure:** show the failed Activity status and retry as a
  new turn; do not call a withheld or ungrounded answer successful.
- **Truncation:** point out the omitted-event or omitted-byte count. A bounded
  prefix is not the complete record.
- **Unaligned time:** keep customer evidence and ContextDesk activity on two
  labelled tracks unless both sides have measured wall-clock time.
- **Restart:** chat-turn Activity and Developer detail do not hydrate after a
  process restart. The corpus and its bounded import summary are separate.

## Pass criteria

The demo passes when an observer can identify what ContextDesk did, which
steps were deterministic, heuristic, probabilistic, or human-approved, what
context reached the model, which tools ran, which citations were host-resolved,
how those citations became Explorer lanes and investigation evidence, and
where the product explicitly refused to claim knowledge it did not have.
