# Rust reference producer

The Rust reference lives at
[`crates/cd-core/examples/normalized_log_producer.rs`](../../../crates/cd-core/examples/normalized_log_producer.rs)
so that it is **compiled and run by the normal build**, rather than sitting
here as an uncompiled copy that could rot against the contract it demonstrates.

```sh
cargo run -p cd-core --example normalized_log_producer
```

Unlike the Node and Python references, it does not reimplement the validator —
it calls `cd_core::normalized_log_events`, which is the authority. A Rust
producer therefore has no opportunity to drift, and the example only has to
show how to *build* conforming events.
