//! Bounded, per-corpus single-flight handle cache for Explorer/library reads
//! (#753).
//!
//! Explorer and library commands reuse initialized [`LogCorpus`] handles so
//! repeated schema/template/vector initialization happens once. The previous
//! cache held one global mutex across the whole cold `LogCorpus::open`, which
//! serialized unrelated corpora and blocked cache hits behind any cold open.
//!
//! # Guarantees
//!
//! * **Same corpus id coalesces.** Concurrent cold opens of one id run a
//!   single initialization (the *leader*); the others wait on that flight
//!   only.
//! * **Different ids are independent.** The cache mutex is never held during
//!   `LogCorpus::open` (DuckDB open, schema, templates, vectors), so hits and
//!   unrelated cold opens never wait behind it.
//! * **Bounded.** At most [`LOG_CORPUS_HANDLE_CACHE_CAP`] ready handles with
//!   least-recently-used eviction (the existing four-entry policy). In-flight
//!   initializations are not entries.
//! * **Never stale.** Hits check the handle's corpus-lifecycle ticket without a
//!   lock: a discarded handle, or one opened before a re-analysis republished
//!   the sidecars, is evicted and reopened instead of served.
//! * **Failure and retry.** An open error reaches the leader and every
//!   coalesced waiter; nothing is cached and the next request retries. A
//!   panicking leader publishes an "abandoned" failure from its drop guard so
//!   waiters never hang, and the cache mutex recovers from poisoning.
//! * **Invalidation/cancellation.** [`LogCorpusHandleCache::invalidate`] drops
//!   the ready entry and detaches any in-flight initialization: its result
//!   still reaches the waiters it already had, but is never inserted.
//! * **Discard.** [`LogCorpusHandleCache::discard`] runs the core lifecycle
//!   transition (fence → invalidate this cache → drain admitted opens →
//!   unpublish), so no handle survives, and no racing open can reinsert one,
//!   once discard success is returned.
//!
//! # Lock ordering
//!
//! 1. `state` (cache mutex): map/LRU bookkeeping only. It may read lifecycle
//!    atomics ([`CachedCorpusHandle::is_current`]) but is never held across an
//!    open, a flight wait, or any `corpus_lifecycle` call that takes a lock.
//! 2. `Flight::outcome`: one flight's result slot. Never held while taking
//!    `state`, and `state` is never held while taking it.
//!
//! The core lifecycle locks (registry → cell) are only taken by
//! `LogCorpus::open`/`discard_with`, which run with neither cache lock held;
//! the discard hook ([`SingleFlightCorpusCache::invalidate`]) takes only
//! `state`, briefly, while no lifecycle lock is held.

use cd_core::log_analysis::{LogCorpus, LOG_CORPUS_DISCARDED};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Ready-handle bound (unchanged policy).
pub(crate) const LOG_CORPUS_HANDLE_CACHE_CAP: usize = 4;

/// Upper bound for a coalesced waiter; the leader keeps initializing.
#[cfg(not(test))]
const FLIGHT_WAIT: Duration = Duration::from_secs(120);
/// Short in tests so a regression that strands waiters fails instead of hanging.
#[cfg(test)]
const FLIGHT_WAIT: Duration = Duration::from_secs(10);

/// Lifecycle view the cache needs from a handle.
pub(crate) trait CachedCorpusHandle: Send + Sync + 'static {
    /// False once a discard of the corpus has begun.
    fn is_live(&self) -> bool;
    /// Live and not republished since the handle opened.
    fn is_current(&self) -> bool;
}

impl CachedCorpusHandle for LogCorpus {
    fn is_live(&self) -> bool {
        LogCorpus::is_live(self)
    }

    fn is_current(&self) -> bool {
        LogCorpus::is_current(self)
    }
}

type OpenOutcome<H> = Result<Arc<H>, String>;

/// One in-progress initialization shared by every same-id caller.
struct Flight<H> {
    outcome: Mutex<Option<OpenOutcome<H>>>,
    ready: Condvar,
    #[cfg(test)]
    waiters: std::sync::atomic::AtomicUsize,
}

impl<H> Flight<H> {
    fn new() -> Self {
        Self {
            outcome: Mutex::new(None),
            ready: Condvar::new(),
            #[cfg(test)]
            waiters: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn publish(&self, outcome: OpenOutcome<H>) {
        let mut slot = self.outcome.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(outcome);
        }
        drop(slot);
        self.ready.notify_all();
    }

    fn wait(&self, corpus_id: &str, timeout: Duration) -> OpenOutcome<H> {
        let slot = self.outcome.lock().unwrap_or_else(PoisonError::into_inner);
        #[cfg(test)]
        self.waiters
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (slot, _) = self
            .ready
            .wait_timeout_while(slot, timeout, |outcome| outcome.is_none())
            .unwrap_or_else(PoisonError::into_inner);
        match slot.as_ref() {
            Some(Ok(handle)) => Ok(Arc::clone(handle)),
            Some(Err(error)) => Err(error.clone()),
            None => Err(format!(
                "log corpus {corpus_id} is still initializing; retry"
            )),
        }
    }
}

struct CacheState<H> {
    ready: HashMap<String, Arc<H>>,
    /// LRU order of `ready` (front = least recently used).
    order: VecDeque<String>,
    /// Attached flights, tagged so a detached leader cannot insert.
    flights: HashMap<String, (u64, Arc<Flight<H>>)>,
    next_flight: u64,
}

impl<H: CachedCorpusHandle> CacheState<H> {
    fn prune_stale(&mut self) {
        if self.ready.values().all(|handle| handle.is_current()) {
            return;
        }
        self.ready.retain(|_, handle| handle.is_current());
        let ready = &self.ready;
        self.order.retain(|id| ready.contains_key(id));
    }

    fn touch(&mut self, corpus_id: &str) {
        self.order.retain(|id| id != corpus_id);
        self.order.push_back(corpus_id.to_string());
    }

    fn insert_ready(&mut self, corpus_id: &str, handle: Arc<H>, capacity: usize) {
        self.ready.remove(corpus_id);
        self.order.retain(|id| id != corpus_id);
        while self.ready.len() >= capacity {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            self.ready.remove(&evicted);
        }
        self.ready.insert(corpus_id.to_string(), handle);
        self.order.push_back(corpus_id.to_string());
    }

    /// Remove this exact flight if it is still attached.
    fn detach_flight(&mut self, corpus_id: &str, flight_id: u64) -> bool {
        let attached = self
            .flights
            .get(corpus_id)
            .is_some_and(|(id, _)| *id == flight_id);
        if attached {
            self.flights.remove(corpus_id);
        }
        attached
    }
}

/// Generic single-flight engine (handle type abstracted for deterministic tests).
pub(crate) struct SingleFlightCorpusCache<H> {
    state: Mutex<CacheState<H>>,
    capacity: usize,
}

impl<H: CachedCorpusHandle> SingleFlightCorpusCache<H> {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            state: Mutex::new(CacheState {
                ready: HashMap::new(),
                order: VecDeque::new(),
                flights: HashMap::new(),
                next_flight: 0,
            }),
            capacity: capacity.max(1),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, CacheState<H>> {
        // Critical sections only edit maps; state stays consistent on panic.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Return a current cached handle, join the in-flight initialization for
    /// `corpus_id`, or lead a new one with `open` (run with no lock held).
    pub(crate) fn get_or_open(
        &self,
        corpus_id: &str,
        open: impl FnOnce() -> Result<H, String>,
    ) -> OpenOutcome<H> {
        let (flight_id, flight) = {
            let mut state = self.lock_state();
            state.prune_stale();
            if let Some(handle) = state.ready.get(corpus_id).cloned() {
                state.touch(corpus_id);
                return Ok(handle);
            }
            if let Some((_, flight)) = state.flights.get(corpus_id) {
                let flight = Arc::clone(flight);
                drop(state);
                return flight.wait(corpus_id, FLIGHT_WAIT);
            }
            let flight_id = state.next_flight;
            state.next_flight = state.next_flight.wrapping_add(1);
            let flight = Arc::new(Flight::new());
            state
                .flights
                .insert(corpus_id.to_string(), (flight_id, Arc::clone(&flight)));
            (flight_id, flight)
        };
        let leader = FlightLeader {
            cache: self,
            corpus_id,
            flight_id,
            flight,
            completed: false,
        };
        let opened = open().map(Arc::new);
        leader.complete(opened)
    }

    /// Drop the ready entry and detach any in-flight initialization.
    pub(crate) fn invalidate(&self, corpus_id: &str) {
        let mut state = self.lock_state();
        state.ready.remove(corpus_id);
        state.order.retain(|id| id != corpus_id);
        state.flights.remove(corpus_id);
    }

    #[cfg(test)]
    fn ready_ids(&self) -> Vec<String> {
        self.lock_state().order.iter().cloned().collect()
    }

    #[cfg(test)]
    fn cached(&self, corpus_id: &str) -> Option<Arc<H>> {
        self.lock_state().ready.get(corpus_id).cloned()
    }

    #[cfg(test)]
    fn flight_count(&self) -> usize {
        self.lock_state().flights.len()
    }

    #[cfg(test)]
    fn flight_waiters(&self, corpus_id: &str) -> usize {
        self.lock_state()
            .flights
            .get(corpus_id)
            .map(|(_, flight)| flight.waiters.load(std::sync::atomic::Ordering::SeqCst))
            .unwrap_or(0)
    }
}

/// Completes (or, on unwind, abandons) one flight.
struct FlightLeader<'a, H: CachedCorpusHandle> {
    cache: &'a SingleFlightCorpusCache<H>,
    corpus_id: &'a str,
    flight_id: u64,
    flight: Arc<Flight<H>>,
    completed: bool,
}

impl<H: CachedCorpusHandle> FlightLeader<'_, H> {
    fn complete(mut self, opened: OpenOutcome<H>) -> OpenOutcome<H> {
        self.completed = true;
        // A discard can fence the corpus after the core open completed but
        // before publication here; never hand out or cache such a handle.
        let outcome = opened.and_then(|handle| {
            if handle.is_live() {
                Ok(handle)
            } else {
                Err(format!(
                    "{LOG_CORPUS_DISCARDED}: {} (discarded while the handle was being cached)",
                    self.corpus_id
                ))
            }
        });
        {
            let mut state = self.cache.lock_state();
            let attached = state.detach_flight(self.corpus_id, self.flight_id);
            if let Ok(handle) = &outcome {
                // A republished-but-live handle is still a valid snapshot for
                // the callers that asked before republication; it is just
                // never cached for later callers.
                if attached && handle.is_current() {
                    state.insert_ready(self.corpus_id, Arc::clone(handle), self.cache.capacity);
                }
            }
        }
        self.flight.publish(outcome.clone());
        outcome
    }
}

impl<H: CachedCorpusHandle> Drop for FlightLeader<'_, H> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        self.cache
            .lock_state()
            .detach_flight(self.corpus_id, self.flight_id);
        self.flight.publish(Err(format!(
            "log corpus {} initialization was abandoned; retry",
            self.corpus_id
        )));
    }
}

/// Explorer/library handle cache over real corpora.
pub(crate) struct LogCorpusHandleCache {
    inner: SingleFlightCorpusCache<LogCorpus>,
}

impl Default for LogCorpusHandleCache {
    fn default() -> Self {
        Self {
            inner: SingleFlightCorpusCache::new(LOG_CORPUS_HANDLE_CACHE_CAP),
        }
    }
}

impl LogCorpusHandleCache {
    /// Shared initialized handle for `corpus_id` (single-flight per id).
    pub(crate) fn open(
        &self,
        cache_root: &Path,
        corpus_id: &str,
    ) -> Result<Arc<LogCorpus>, String> {
        self.inner.get_or_open(corpus_id, || {
            LogCorpus::open(cache_root, corpus_id).map_err(|error| error.to_string())
        })
    }

    /// Drop the cached handle and detach in-flight initialization (for
    /// example after a re-analysis finished, successfully or not).
    pub(crate) fn invalidate(&self, corpus_id: &str) {
        self.inner.invalidate(corpus_id);
    }

    /// Discard `corpus_id` as one fenced lifecycle transition, invalidating
    /// this cache inside the fenced window.
    pub(crate) fn discard(&self, cache_root: &Path, corpus_id: &str) -> Result<(), String> {
        LogCorpus::discard_with(cache_root, corpus_id, || self.inner.invalidate(corpus_id))
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    const WAIT: Duration = Duration::from_secs(10);

    /// `unwrap_err` without requiring `Debug` handles (`LogCorpus` is not).
    fn expect_open_error<H>(outcome: OpenOutcome<H>, what: &str) -> String {
        match outcome {
            Ok(_) => panic!("{what}: expected an open failure, got a handle"),
            Err(error) => error,
        }
    }

    struct FakeHandle {
        serial: usize,
        live: AtomicBool,
        current: AtomicBool,
    }

    impl FakeHandle {
        fn new(serial: usize) -> Self {
            Self {
                serial,
                live: AtomicBool::new(true),
                current: AtomicBool::new(true),
            }
        }
    }

    impl CachedCorpusHandle for FakeHandle {
        fn is_live(&self) -> bool {
            self.live.load(Ordering::SeqCst)
        }

        fn is_current(&self) -> bool {
            self.is_live() && self.current.load(Ordering::SeqCst)
        }
    }

    type FakeCache = Arc<SingleFlightCorpusCache<FakeHandle>>;

    fn fake_cache() -> FakeCache {
        Arc::new(SingleFlightCorpusCache::new(LOG_CORPUS_HANDLE_CACHE_CAP))
    }

    fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
        let started = Instant::now();
        while !condition() {
            assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Leader whose open blocks until released; returns its join handle.
    fn blocked_leader(
        cache: &FakeCache,
        corpus_id: &'static str,
        opens: &Arc<AtomicUsize>,
        outcome: Result<usize, &'static str>,
    ) -> (
        std::thread::JoinHandle<OpenOutcome<FakeHandle>>,
        mpsc::Sender<()>,
    ) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let cache = Arc::clone(cache);
        let opens = Arc::clone(opens);
        let leader = std::thread::spawn(move || {
            cache.get_or_open(corpus_id, move || {
                opens.fetch_add(1, Ordering::SeqCst);
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
                outcome.map(FakeHandle::new).map_err(str::to_string)
            })
        });
        entered_rx.recv_timeout(WAIT).expect("leader entered open");
        (leader, release_tx)
    }

    #[test]
    fn same_id_cold_opens_coalesce_into_one_initialization() {
        let cache = fake_cache();
        let opens = Arc::new(AtomicUsize::new(0));
        let (leader, release) = blocked_leader(&cache, "a", &opens, Ok(1));
        let waiters: Vec<_> = (0..6)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let opens = Arc::clone(&opens);
                std::thread::spawn(move || {
                    cache.get_or_open("a", || {
                        opens.fetch_add(1, Ordering::SeqCst);
                        Ok(FakeHandle::new(99))
                    })
                })
            })
            .collect();
        wait_until("six coalesced waiters", || cache.flight_waiters("a") == 6);
        release.send(()).unwrap();
        let led = leader.join().unwrap().unwrap();
        for waiter in waiters {
            let joined = waiter.join().unwrap().unwrap();
            assert!(
                Arc::ptr_eq(&led, &joined),
                "waiters share the leader's handle"
            );
        }
        assert_eq!(
            opens.load(Ordering::SeqCst),
            1,
            "exactly one initialization"
        );
        assert_eq!(led.serial, 1);
        assert_eq!(cache.ready_ids(), vec!["a".to_string()]);
        assert_eq!(cache.flight_count(), 0);
    }

    #[test]
    fn different_ids_initialize_independently_and_hits_are_not_blocked() {
        let cache = fake_cache();
        let hot = cache.get_or_open("hot", || Ok(FakeHandle::new(1))).unwrap();
        let opens = Arc::new(AtomicUsize::new(0));
        let (slow, release_slow) = blocked_leader(&cache, "slow", &opens, Ok(2));

        // While "slow" is mid-initialization: a hit and an unrelated cold
        // open both complete without waiting for it.
        let (done_tx, done_rx) = mpsc::channel();
        let worker_cache = Arc::clone(&cache);
        let worker = std::thread::spawn(move || {
            let hit = worker_cache
                .get_or_open("hot", || Err("hit must not reopen".into()))
                .unwrap();
            let fast = worker_cache
                .get_or_open("fast", || Ok(FakeHandle::new(3)))
                .unwrap();
            done_tx.send(()).unwrap();
            (hit, fast)
        });
        done_rx
            .recv_timeout(WAIT)
            .expect("hit and unrelated cold open must not wait for a cold open");
        assert!(!slow.is_finished(), "the slow leader is still initializing");
        let (hit, fast) = worker.join().unwrap();
        assert!(Arc::ptr_eq(&hit, &hot));
        assert_eq!(fast.serial, 3);

        release_slow.send(()).unwrap();
        assert_eq!(slow.join().unwrap().unwrap().serial, 2);
        assert_eq!(opens.load(Ordering::SeqCst), 1);
        let mut ready = cache.ready_ids();
        ready.sort();
        assert_eq!(ready, vec!["fast", "hot", "slow"]);
    }

    #[test]
    fn open_failure_reaches_every_waiter_and_a_retry_succeeds() {
        let cache = fake_cache();
        let opens = Arc::new(AtomicUsize::new(0));
        let (leader, release) = blocked_leader(&cache, "f", &opens, Err("schema boom"));
        let waiter_cache = Arc::clone(&cache);
        let waiter = std::thread::spawn(move || {
            waiter_cache.get_or_open("f", || Err("waiter must not open".into()))
        });
        wait_until("one coalesced waiter", || cache.flight_waiters("f") == 1);
        release.send(()).unwrap();
        assert_eq!(
            expect_open_error(leader.join().unwrap(), "leader"),
            "schema boom"
        );
        assert_eq!(
            expect_open_error(waiter.join().unwrap(), "waiter"),
            "schema boom"
        );
        assert!(cache.ready_ids().is_empty(), "failures are never cached");
        assert_eq!(cache.flight_count(), 0, "failed flight is released");

        let retried = cache
            .get_or_open("f", || {
                opens.fetch_add(1, Ordering::SeqCst);
                Ok(FakeHandle::new(7))
            })
            .unwrap();
        assert_eq!(retried.serial, 7);
        assert_eq!(opens.load(Ordering::SeqCst), 2, "retry re-initializes");
        assert_eq!(cache.ready_ids(), vec!["f".to_string()]);
    }

    #[test]
    fn panicking_initialization_releases_waiters_and_allows_retry() {
        let cache = fake_cache();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let leader_cache = Arc::clone(&cache);
        let leader = std::thread::spawn(move || {
            leader_cache.get_or_open("p", move || -> Result<FakeHandle, String> {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
                panic!("injected initialization panic");
            })
        });
        entered_rx.recv_timeout(WAIT).unwrap();
        let waiter_cache = Arc::clone(&cache);
        let waiter = std::thread::spawn(move || {
            waiter_cache.get_or_open("p", || Err("waiter must not open".into()))
        });
        wait_until("waiter joined the doomed flight", || {
            cache.flight_waiters("p") == 1
        });
        release_tx.send(()).unwrap();
        assert!(leader.join().is_err(), "leader thread panicked");
        let error = expect_open_error(waiter.join().unwrap(), "waiter");
        assert!(error.contains("abandoned"), "{error}");
        assert_eq!(cache.flight_count(), 0);

        let retried = cache.get_or_open("p", || Ok(FakeHandle::new(5))).unwrap();
        assert_eq!(retried.serial, 5, "cache stays usable after a panic");
    }

    #[test]
    fn four_entry_lru_bound_is_preserved() {
        let cache = fake_cache();
        for (serial, id) in ["a", "b", "c", "d"].into_iter().enumerate() {
            cache
                .get_or_open(id, || Ok(FakeHandle::new(serial)))
                .unwrap();
        }
        // Touch "a" so "b" becomes least recently used.
        cache
            .get_or_open("a", || Err("hit must not reopen".into()))
            .unwrap();
        cache.get_or_open("e", || Ok(FakeHandle::new(4))).unwrap();
        assert_eq!(cache.ready_ids(), vec!["c", "d", "a", "e"]);
        let reopened = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&reopened);
        cache
            .get_or_open("b", move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(FakeHandle::new(10))
            })
            .unwrap();
        assert_eq!(reopened.load(Ordering::SeqCst), 1, "evicted entry reopens");
        assert_eq!(cache.ready_ids().len(), LOG_CORPUS_HANDLE_CACHE_CAP);
        assert_eq!(cache.ready_ids(), vec!["d", "a", "e", "b"]);
    }

    #[test]
    fn stale_entries_are_reopened_never_served() {
        let cache = fake_cache();
        let first = cache.get_or_open("s", || Ok(FakeHandle::new(1))).unwrap();
        // Republished (re-analysis): live but not current.
        first.current.store(false, Ordering::SeqCst);
        let second = cache.get_or_open("s", || Ok(FakeHandle::new(2))).unwrap();
        assert_eq!(second.serial, 2);
        assert!(!Arc::ptr_eq(&first, &second));
        // Discarded: not live.
        second.live.store(false, Ordering::SeqCst);
        let third = cache.get_or_open("s", || Ok(FakeHandle::new(3))).unwrap();
        assert_eq!(third.serial, 3);
        assert_eq!(cache.ready_ids(), vec!["s".to_string()]);
    }

    #[test]
    fn invalidate_detaches_an_inflight_open_so_it_is_never_inserted() {
        let cache = fake_cache();
        let opens = Arc::new(AtomicUsize::new(0));
        let (leader, release) = blocked_leader(&cache, "r", &opens, Ok(1));
        cache.invalidate("r");
        assert_eq!(cache.flight_count(), 0, "flight detached");
        // A caller after invalidation starts a fresh initialization.
        let fresh = cache.get_or_open("r", || Ok(FakeHandle::new(2))).unwrap();
        assert_eq!(fresh.serial, 2);
        release.send(()).unwrap();
        let detached = leader.join().unwrap().unwrap();
        assert_eq!(detached.serial, 1, "its own waiters still get a result");
        let cached = cache.cached("r").expect("fresh handle cached");
        assert!(
            Arc::ptr_eq(&cached, &fresh),
            "detached result never inserted"
        );
    }

    #[test]
    fn leader_result_fenced_after_open_is_rejected_for_everyone() {
        let cache = fake_cache();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let leader_cache = Arc::clone(&cache);
        let leader = std::thread::spawn(move || {
            leader_cache.get_or_open("x", move || {
                let handle = FakeHandle::new(1);
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
                // A discard fenced the corpus after the open completed.
                handle.live.store(false, Ordering::SeqCst);
                Ok(handle)
            })
        });
        entered_rx.recv_timeout(WAIT).unwrap();
        let waiter_cache = Arc::clone(&cache);
        let waiter = std::thread::spawn(move || {
            waiter_cache.get_or_open("x", || Err("waiter must not open".into()))
        });
        wait_until("waiter joined", || cache.flight_waiters("x") == 1);
        release_tx.send(()).unwrap();
        for error in [
            expect_open_error(leader.join().unwrap(), "leader"),
            expect_open_error(waiter.join().unwrap(), "waiter"),
        ] {
            assert!(error.starts_with(LOG_CORPUS_DISCARDED), "{error}");
        }
        assert!(cache.ready_ids().is_empty());
    }

    // ---- Real corpus lifecycle integration (cd-core LogCorpus). ----

    fn real_corpus(cache: &Path, name: &str) -> String {
        let corpus = LogCorpus::create(cache, name).expect("create corpus");
        corpus.flush().expect("flush corpus");
        corpus.id().to_string()
    }

    #[test]
    fn discard_through_the_cache_leaves_no_live_handle_and_no_entry() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let id = real_corpus(&cache, "discard");
        let other = real_corpus(&cache, "other");
        let handles = LogCorpusHandleCache::default();
        let cached = handles.open(&cache, &id).unwrap();
        let other_handle = handles.open(&cache, &other).unwrap();
        // A retained copy stands in for a linked turn's turn-local handle.
        let retained = Arc::clone(&cached);

        handles.discard(&cache, &id).expect("discard succeeds");

        assert!(!retained.is_live(), "no handle survives discard success");
        let error = retained.ensure_live().unwrap_err().to_string();
        assert!(
            cd_core::log_analysis::is_corpus_discarded_message(&error),
            "{error}"
        );
        assert!(handles.inner.cached(&id).is_none(), "entry invalidated");
        let reopen = expect_open_error(handles.open(&cache, &id), "reopen");
        assert!(
            cd_core::log_analysis::is_corpus_discarded_message(&reopen),
            "a discarded corpus cannot be reopened through the cache: {reopen}"
        );
        assert!(handles.inner.cached(&id).is_none(), "no reinsertion");
        assert!(!cache.join("log_corpora").join(&id).exists());
        assert_eq!(LogCorpus::list_ids(&cache).unwrap(), vec![other.clone()]);
        // Negative control: the other corpus is untouched and still cached.
        assert!(other_handle.is_live());
        let other_again = handles.open(&cache, &other).unwrap();
        assert!(Arc::ptr_eq(&other_handle, &other_again));
    }

    #[test]
    fn open_racing_discard_cannot_reinsert_a_handle() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let id = real_corpus(&cache, "race");
        let handles = Arc::new(LogCorpusHandleCache::default());
        let (opened_tx, opened_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();

        // Barrier: the leader finished the core open (handle live) and pauses
        // before the cache publishes it.
        let leader_handles = Arc::clone(&handles);
        let leader_cache = cache.clone();
        let leader_id = id.clone();
        let leader = std::thread::spawn(move || {
            leader_handles.inner.get_or_open(&leader_id, || {
                let corpus =
                    LogCorpus::open(&leader_cache, &leader_id).map_err(|e| e.to_string())?;
                opened_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
                Ok(corpus)
            })
        });
        opened_rx.recv_timeout(WAIT).unwrap();
        let waiter_handles = Arc::clone(&handles);
        let waiter_cache = cache.clone();
        let waiter_id = id.clone();
        let waiter = std::thread::spawn(move || waiter_handles.open(&waiter_cache, &waiter_id));
        wait_until("waiter coalesced", || {
            handles.inner.flight_waiters(&id) == 1
        });

        // Discard publishes success while the racing open is paused.
        handles.discard(&cache, &id).expect("discard succeeds");
        assert!(!cache.join("log_corpora").join(&id).exists());
        release_tx.send(()).unwrap();

        for error in [
            expect_open_error(leader.join().unwrap(), "leader"),
            expect_open_error(waiter.join().unwrap(), "waiter"),
        ] {
            assert!(
                cd_core::log_analysis::is_corpus_discarded_message(&error),
                "racing open must fail as discarded: {error}"
            );
        }
        assert!(handles.inner.cached(&id).is_none(), "no handle reinserted");
        assert_eq!(handles.inner.flight_count(), 0);
    }

    #[test]
    fn republication_and_explicit_invalidation_force_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let id = real_corpus(&cache, "reanalysis");
        let handles = LogCorpusHandleCache::default();
        let before = handles.open(&cache, &id).unwrap();
        let hit = handles.open(&cache, &id).unwrap();
        assert!(Arc::ptr_eq(&before, &hit), "positive control: hit reuses");

        // A trusted re-analysis publication (begin + end) republishes sidecars.
        drop(
            cd_core::log_analysis::corpus_lifecycle::begin_publication(&cache, &id)
                .expect("publication"),
        );
        let after = handles.open(&cache, &id).unwrap();
        assert!(
            !Arc::ptr_eq(&before, &after),
            "republished handle not served"
        );
        assert!(before.is_live(), "republication is not a discard");
        assert!(after.is_current());

        handles.invalidate(&id);
        let reopened = handles.open(&cache, &id).unwrap();
        assert!(
            !Arc::ptr_eq(&after, &reopened),
            "invalidation forces a reopen"
        );
    }
}
