# Gateway diagnostic honesty v1

This lane hardens the evidence boundary of `contextdesk gateway diagnose`.
It does not make a provider pass, retry a failed model, or infer quality from
a model name.

## Extended attempts

`--level extended` runs the planned product-path case twice. The usefulness
scorer is fail-closed: every planned attempt must complete and pass. A
fail-then-pass or pass-then-fail sequence remains `retry_required` and its
`answers_useful_status` is `fail`; a retry is evidence of instability, not a
quality pass. A deadline that prevents the complete attempt set is reported as
`incomplete_attempt_set`.

## Diagnostic faults

`diagnostic_fault` is reserved for an internally inconsistent host projection,
not a provider failure. The current replay fixture covers a validated typed
investigation envelope with no visible answer projection. The case remains
non-ready for the affected workflow and usefulness dimensions are
`inconclusive`, avoiding a false `response_contract` or usefulness claim.

## Automation exit contract

The CLI exits `8` (`not_ready`) when gateway compatibility or product
compatibility is false, or when `answers_useful_status=fail`. It may exit zero
for an `answers_useful_status=inconclusive` specialty diagnostic that has no
answer scorer, but the report still says `inconclusive`; callers must not
interpret that as a usefulness pass. Ctrl-C remains `130`.

## Hermetic coverage

- `fixtures/gateway-contracts/v1/diagnostic-projection-typed-envelope.json`
  replays the projection/typed-envelope mismatch without provider bodies.
- CLI unit tests cover the replay, mixed-attempt fail-closed aggregation,
  diagnostic-fault classification, and the non-ready exit predicate.

The focused assertions are mutation-oriented: allowing a mixed attempt set,
allowing an incomplete extended set, removing the diagnostic-fault redaction
precedence, or making a usefulness failure exit zero each contradicts a test.

The live DeepSeek captures remain owner-local and are not copied into the
repository.

## Streaming and cancellation audit

No source change was warranted in this lane. Qualification already requires
actual streamed content for `streaming`, marks a cancellation-shaped response
`untested`, and uses a probe-local cancel flag rather than mutating the
operator's run-cancel flag. Existing unit and gateway-wire tests cover
mid-stream cancellation, cancellation before a request, no replay after a
stream failure, and the distinction between probe cancellation and user
cancellation. A scripted response cannot fabricate a streaming pass without
both the stream marker and non-empty content.
