# Triage Policy V2 role-qualification cancellation hardening

The exact-role qualification path now applies the host cancellation boundary
before any provider work, including the host-validated Finalizer probe.

The finalizer probe uses the same cooperative cancel signal as contributor
probes. A pre-cancelled request returns `Unqualified` with reason `cancelled`
and `physical_provider_calls = 0`; it cannot mint a qualified record from a
valid scripted/provider response. A cancellation observed while the probe is
waiting also fails closed and does not receive qualification credit.

Focused proof:

```bash
cargo test -p cd-workflow --lib triage_role_qualification -- --nocapture
cargo clippy -p cd-workflow --all-targets -- -D warnings
```

The focused unit suite includes valid typed contributor, TimelineAnalyst,
Reviewer, and Finalizer qualification plus the pre-cancelled Finalizer
regression. The broader adversarial audit that found this issue remains on
`test/triage-policy-v2-qualification-adversarial-audit-v1` as a separate
hermetic audit lane; its older Timeline/Reviewer refusal assumptions are not
merged because those roles are now supported on the release line.

No live gateway, credential, Keychain, or raw provider capture is involved.
