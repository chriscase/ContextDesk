//! Process-local log-corpus lifecycle gate (#753).
//!
//! A [`LogCorpus`](super::LogCorpus) handle is an initialized view of files
//! that a discard may delete or a trusted re-analysis may republish. Hosts keep
//! such handles in several places at once: the desktop Explorer handle cache, a
//! [`ToolHost`](crate::tool_host::ToolHost) turn-local slot, and owned
//! broad-triage jobs on blocking workers. This module makes discard and
//! republication authoritative for **every** handle in the process, whichever
//! cache holds it, without putting a lock around DuckDB open or query work.
//!
//! # Model
//!
//! One [`CorpusLifecycle`] cell exists per corpus directory (keyed by the
//! canonical `log_corpora` directory plus the directory name). It owns:
//!
//! * a **fence epoch**, advanced exactly once when a discard begins. Every
//!   handle records the epoch it was opened under in its
//!   [`CorpusLifecycleTicket`]. A ticket whose epoch is no longer current is
//!   *stale*: every fenced operation through it fails with an error starting
//!   with [`LOG_CORPUS_DISCARDED`]. Liveness checks read this atomic only.
//! * a **content generation**, advanced when a sidecar publication (trusted
//!   template re-analysis) begins and again when it ends. Hosts that retain
//!   handles across commands treat a changed generation as "reopen", so a
//!   republished vector index is never served from an older handle.
//! * a small **phase** ([`CorpusLifecyclePhase`]) plus the number of admitted
//!   file-touching sections (cold opens and publications).
//!
//! # Discard transition
//!
//! [`discard_corpus_root`] performs one ordered transition:
//!
//! 1. **Fence** — phase `Live` → `Discarding`, epoch += 1. New opens and
//!    publications are rejected and every existing handle is stale from this
//!    instant, so in-flight reads cannot validate their results afterwards.
//! 2. **Invalidate** — the caller's `on_fenced` hook drops host cache entries
//!    and detaches in-flight cache initializations. It runs with no lifecycle
//!    lock held.
//! 3. **Drain** — wait until already admitted cold opens and publications
//!    finish. Their completion re-checks the epoch, so none of them can publish
//!    a live handle; once drained nothing in this process is still creating or
//!    replacing files in the directory.
//! 4. **Release** — the caller's `release_files` hook closes the corpus's
//!    shared DuckDB connection (stale handles are left with an inert
//!    in-memory connection), so no file in the directory stays open in this
//!    process and the move below also works where open files block renames.
//! 5. **Unpublish** — atomically rename `log_corpora/{id}` to
//!    `log_corpora/.discarding/{id}.{suffix}`. This rename is the instant the
//!    corpus leaves the filesystem namespace. If it fails, nothing on disk has
//!    changed: the phase rolls back to its prior value (old handles stay
//!    stale and report an *interrupted* discard, fresh opens receive the new
//!    epoch) and the error is returned for an honest retry.
//! 6. **Publish** — phase → `Discarded`, then best-effort removal of the
//!    renamed tree (and of older residue under `.discarding/`). A removal
//!    failure leaves only unlisted residue that later discards sweep; it can
//!    never resurrect or partially expose the corpus.
//!
//! Discard success is therefore reported only after every handle is stale, no
//! host cache can reinsert one, and the corpus directory is gone.
//!
//! # Lock ordering
//!
//! * `LIFECYCLES` (registry mutex) → nothing. Held only to look up, insert, or
//!   prune cells. Pruning reads `Arc::strong_count`, never a cell lock.
//! * Cell `state` mutex → nothing. Held only for O(1) bookkeeping and condvar
//!   waits; never across filesystem, DuckDB, host-callback, or cache work and
//!   never while acquiring the registry.
//! * Host cache locks may be held while reading ticket atomics
//!   ([`CorpusLifecycleTicket::is_live`], [`CorpusLifecycleTicket::is_current`])
//!   but never while calling a function in this module that *waits* on a cell
//!   (admission, publication, discard). [`CorpusLifecycleTicket::ensure_live`]
//!   may be called under a host lock: on the stale path it takes the cell lock
//!   as a leaf only to read the phase for its error message.
//! * [`SharedPerCorpus`] registry mutex → nothing. Held only for map
//!   bookkeeping; a per-key gate makes same-key initializers wait for one
//!   leader while different keys initialize concurrently, so no registry lock
//!   is held across DuckDB open or schema initialization. The store's discard
//!   release may take it while holding one corpus connection (connection →
//!   registry); nothing takes them in the opposite order.
//!
//! The lifecycle is process-local, like the shared DuckDB connection registry
//! in [`super::store`]. Other processes opening the same cache are outside this
//! fence (see `docs/testing/LOG_CORPUS_CACHE_LIFECYCLE_753.md`).

use crate::error::{CoreError, CoreResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// Stable prefix of every error raised by a discard fence.
///
/// Hosts and the agent loop use [`is_corpus_discarded_error`] /
/// [`is_corpus_discarded_message`] to surface a dedicated, visible terminal
/// instead of treating the failure as an ordinary empty result.
pub const LOG_CORPUS_DISCARDED: &str = "log corpus was discarded";

/// Hidden, unlisted directory under `log_corpora/` that receives discarded
/// corpus trees before deletion. Its name can never be a valid corpus id.
pub const DISCARD_TRASH_DIR: &str = ".discarding";

/// Upper bound for an open waiting out an in-progress sidecar publication.
const OPEN_ADMISSION_WAIT: Duration = Duration::from_secs(60);

/// Upper bound for a discard waiting for admitted opens/publications.
const DISCARD_DRAIN_WAIT: Duration = Duration::from_secs(120);

/// Bounded rename attempts when a concurrent sweep removed the trash dir.
const UNPUBLISH_RENAME_ATTEMPTS: usize = 3;

/// Discarded tombstones kept after their last handle is gone, so a late open
/// still reports "discarded" rather than a generic "not found". Oldest
/// unreferenced tombstones are pruned beyond this bound.
pub const MAX_RETAINED_TOMBSTONES: usize = 256;

static LIFECYCLES: LazyLock<Mutex<HashMap<PathBuf, Arc<CorpusLifecycle>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static TOMBSTONE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Monotonic age of discard tombstones (0 = not a tombstone).
static TOMBSTONE_AGE: AtomicU64 = AtomicU64::new(0);

/// Coarse lifecycle phase of one corpus directory in this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorpusLifecyclePhase {
    /// Opens and publications are admitted.
    Live,
    /// A discard has fenced the corpus and is invalidating/removing it.
    Discarding,
    /// The directory was unpublished by a successful discard.
    Discarded,
}

#[derive(Debug)]
struct LifecycleState {
    phase: CorpusLifecyclePhase,
    active_opens: usize,
    active_publications: usize,
}

/// Per-directory lifecycle cell shared by every handle of that corpus.
pub struct CorpusLifecycle {
    directory_id: String,
    state: Mutex<LifecycleState>,
    changed: Condvar,
    /// Advanced once per discard fence; handles carry the value they opened under.
    epoch: AtomicU64,
    /// Advanced at the start and end of every sidecar publication.
    content: AtomicU64,
    /// Non-zero (tombstone age) once a discard succeeded. Mirrors the phase so
    /// registry pruning never takes a cell lock.
    tombstone: AtomicU64,
}

impl std::fmt::Debug for CorpusLifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CorpusLifecycle")
            .field("directory_id", &self.directory_id)
            .field("epoch", &self.epoch.load(Ordering::SeqCst))
            .field("content", &self.content.load(Ordering::SeqCst))
            .field("phase", &self.phase())
            .finish()
    }
}

fn discarded_error(directory_id: &str, detail: &str) -> CoreError {
    CoreError::Message(format!("{LOG_CORPUS_DISCARDED}: {directory_id} ({detail})"))
}

fn busy_error(directory_id: &str, detail: &str) -> CoreError {
    CoreError::Message(format!(
        "log corpus {directory_id} is busy ({detail}); retry"
    ))
}

/// True when `error` was raised by a discard fence (stale handle, discard in
/// progress, or already discarded).
pub fn is_corpus_discarded_error(error: &CoreError) -> bool {
    matches!(error, CoreError::Message(message) if is_corpus_discarded_message(message))
}

/// String form of [`is_corpus_discarded_error`] for hosts that carry
/// stringified errors across IPC boundaries.
pub fn is_corpus_discarded_message(message: &str) -> bool {
    message.starts_with(LOG_CORPUS_DISCARDED)
}

fn lifecycle_key(cache_root: &Path, directory_id: &str) -> PathBuf {
    let corpora = cache_root.join("log_corpora");
    std::fs::canonicalize(&corpora)
        .or_else(|_| std::fs::canonicalize(cache_root).map(|root| root.join("log_corpora")))
        .unwrap_or(corpora)
        .join(directory_id)
}

/// Shared lifecycle cell for `cache_root/log_corpora/{directory_id}`.
///
/// Live cells that no handle, admission, publication, or discard references
/// are pruned on lookup: no handle can observe them any more. Discard
/// tombstones are retained (bounded by [`MAX_RETAINED_TOMBSTONES`]) so a late
/// open of a discarded corpus fails as discarded instead of "not found".
pub fn lifecycle_for(cache_root: &Path, directory_id: &str) -> Arc<CorpusLifecycle> {
    let key = lifecycle_key(cache_root, directory_id);
    let mut cells = LIFECYCLES.lock().unwrap_or_else(PoisonError::into_inner);
    prune_registry(&mut cells);
    Arc::clone(
        cells
            .entry(key)
            .or_insert_with(|| Arc::new(CorpusLifecycle::new(directory_id))),
    )
}

fn prune_registry(cells: &mut HashMap<PathBuf, Arc<CorpusLifecycle>>) {
    prune_registry_with_cap(cells, MAX_RETAINED_TOMBSTONES);
}

fn prune_registry_with_cap(cells: &mut HashMap<PathBuf, Arc<CorpusLifecycle>>, cap: usize) {
    cells.retain(|_, cell| {
        Arc::strong_count(cell) > 1 || cell.tombstone.load(Ordering::SeqCst) != 0
    });
    let idle_tombstones = cells
        .values()
        .filter(|cell| Arc::strong_count(cell) == 1)
        .count();
    if idle_tombstones <= cap {
        return;
    }
    let mut idle: Vec<(u64, PathBuf)> = cells
        .iter()
        .filter(|(_, cell)| Arc::strong_count(cell) == 1)
        .map(|(key, cell)| (cell.tombstone.load(Ordering::SeqCst), key.clone()))
        .collect();
    idle.sort_unstable();
    let excess = idle.len() - cap;
    for (_, key) in idle.into_iter().take(excess) {
        cells.remove(&key);
    }
}

impl CorpusLifecycle {
    fn new(directory_id: &str) -> Self {
        Self {
            directory_id: directory_id.to_string(),
            state: Mutex::new(LifecycleState {
                phase: CorpusLifecyclePhase::Live,
                active_opens: 0,
                active_publications: 0,
            }),
            changed: Condvar::new(),
            epoch: AtomicU64::new(0),
            content: AtomicU64::new(0),
            tombstone: AtomicU64::new(0),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, LifecycleState> {
        // Every critical section only adjusts counters/phase, so the state is
        // consistent even if a holder panicked.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wait_until<'a>(
        &'a self,
        mut state: MutexGuard<'a, LifecycleState>,
        deadline: Instant,
        mut done: impl FnMut(&LifecycleState) -> bool,
    ) -> Result<MutexGuard<'a, LifecycleState>, MutexGuard<'a, LifecycleState>> {
        while !done(&state) {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(state);
            };
            let (next, _) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
        }
        Ok(state)
    }

    /// Directory name this cell guards.
    pub fn directory_id(&self) -> &str {
        &self.directory_id
    }

    /// Current phase (diagnostics and tests).
    pub fn phase(&self) -> CorpusLifecyclePhase {
        self.lock_state().phase
    }

    /// Fail when the corpus is fenced or discarded.
    pub fn ensure_not_fenced(&self) -> CoreResult<()> {
        match self.lock_state().phase {
            CorpusLifecyclePhase::Live => Ok(()),
            CorpusLifecyclePhase::Discarding => {
                Err(discarded_error(&self.directory_id, "discard in progress"))
            }
            CorpusLifecyclePhase::Discarded => Err(discarded_error(
                &self.directory_id,
                "corpus no longer exists",
            )),
        }
    }

    /// Admit one cold open.
    ///
    /// Rejects fenced corpora and waits (bounded) for an in-progress sidecar
    /// publication so an open never reads a half-published template set. The
    /// returned admission must be completed with [`OpenAdmission::finish`]
    /// after the files were read; a discard waits for it to finish or drop.
    pub fn admit_open(self: &Arc<Self>) -> CoreResult<OpenAdmission> {
        self.admit_open_inner(false)
    }

    fn admit_open_inner(self: &Arc<Self>, within_publication: bool) -> CoreResult<OpenAdmission> {
        let deadline = Instant::now() + OPEN_ADMISSION_WAIT;
        let state = self.lock_state();
        let mut state = match self.wait_until(state, deadline, |state| {
            state.phase != CorpusLifecyclePhase::Live
                || within_publication
                || state.active_publications == 0
        }) {
            Ok(state) => state,
            Err(_) => {
                return Err(busy_error(
                    &self.directory_id,
                    "a template re-analysis is still publishing",
                ))
            }
        };
        match state.phase {
            CorpusLifecyclePhase::Live => {}
            CorpusLifecyclePhase::Discarding => {
                return Err(discarded_error(&self.directory_id, "discard in progress"))
            }
            CorpusLifecyclePhase::Discarded => {
                return Err(discarded_error(
                    &self.directory_id,
                    "corpus no longer exists",
                ))
            }
        }
        state.active_opens += 1;
        let epoch = self.epoch.load(Ordering::SeqCst);
        let content = self.content.load(Ordering::SeqCst);
        drop(state);
        Ok(OpenAdmission {
            cell: Arc::clone(self),
            epoch,
            content,
            within_publication,
        })
    }

    #[cfg(test)]
    pub(crate) fn active_sections(&self) -> (usize, usize) {
        let state = self.lock_state();
        (state.active_opens, state.active_publications)
    }

    #[cfg(test)]
    pub(crate) fn wait_for_phase(&self, phase: CorpusLifecyclePhase, timeout: Duration) -> bool {
        let state = self.lock_state();
        self.wait_until(state, Instant::now() + timeout, |state| {
            state.phase == phase
        })
        .is_ok()
    }
}

/// Identity of one handle within its corpus lifecycle.
#[derive(Clone)]
pub struct CorpusLifecycleTicket {
    cell: Arc<CorpusLifecycle>,
    epoch: u64,
    content: u64,
}

impl std::fmt::Debug for CorpusLifecycleTicket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CorpusLifecycleTicket")
            .field("directory_id", &self.cell.directory_id)
            .field("epoch", &self.epoch)
            .field("content", &self.content)
            .field("live", &self.is_live())
            .field("current", &self.is_current())
            .finish()
    }
}

impl CorpusLifecycleTicket {
    /// Directory name of the guarded corpus.
    pub fn directory_id(&self) -> &str {
        &self.cell.directory_id
    }

    /// False once any discard of this corpus has begun (lock-free).
    pub fn is_live(&self) -> bool {
        self.cell.epoch.load(Ordering::SeqCst) == self.epoch
    }

    /// Live and no sidecar publication has begun since this handle opened.
    pub fn is_current(&self) -> bool {
        self.is_live() && self.cell.content.load(Ordering::SeqCst) == self.content
    }

    /// Fail closed for a stale handle.
    ///
    /// While a discard is running or after it succeeded the error starts with
    /// [`LOG_CORPUS_DISCARDED`]. If the discard that fenced this handle rolled
    /// back (the corpus still exists), the error says so instead, because the
    /// corpus was not discarded and a fresh open is valid.
    pub fn ensure_live(&self) -> CoreResult<()> {
        if self.is_live() {
            return Ok(());
        }
        Err(match self.cell.phase() {
            CorpusLifecyclePhase::Discarding => discarded_error(
                &self.cell.directory_id,
                "discard in progress; this handle's results are not evidence",
            ),
            CorpusLifecyclePhase::Discarded => discarded_error(
                &self.cell.directory_id,
                "this handle was invalidated by a discard; its results are not evidence",
            ),
            CorpusLifecyclePhase::Live => CoreError::Message(format!(
                "log corpus {} handle was invalidated by an interrupted discard; \
                 the corpus still exists, reopen it and retry",
                self.cell.directory_id
            )),
        })
    }

    /// Shared cell (tests and diagnostics).
    pub fn lifecycle(&self) -> &Arc<CorpusLifecycle> {
        &self.cell
    }
}

/// Why a completed open must not be published.
#[derive(Debug)]
pub enum OpenRace {
    /// A discard fenced the corpus while its files were being read.
    Discarded(CoreError),
    /// A sidecar publication began while its files were being read; reopen.
    Republished,
}

/// One admitted cold open. Dropping it without [`Self::finish`] (error or
/// panic in the open path) releases the admission so a discard can proceed.
pub struct OpenAdmission {
    cell: Arc<CorpusLifecycle>,
    epoch: u64,
    content: u64,
    within_publication: bool,
}

impl std::fmt::Debug for OpenAdmission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAdmission")
            .field("directory_id", &self.cell.directory_id)
            .field("epoch", &self.epoch)
            .field("content", &self.content)
            .field("within_publication", &self.within_publication)
            .finish()
    }
}

impl OpenAdmission {
    /// Ticket the opened handle will carry if [`Self::finish`] succeeds.
    pub fn ticket(&self) -> CorpusLifecycleTicket {
        CorpusLifecycleTicket {
            cell: Arc::clone(&self.cell),
            epoch: self.epoch,
            content: self.content,
        }
    }

    /// Validate that no discard (and, outside a publication, no republication)
    /// began while the files were read, then release the admission.
    pub fn finish(self) -> Result<(), OpenRace> {
        if self.cell.epoch.load(Ordering::SeqCst) != self.epoch {
            return Err(OpenRace::Discarded(discarded_error(
                &self.cell.directory_id,
                "discarded while the corpus was being opened",
            )));
        }
        if !self.within_publication && self.cell.content.load(Ordering::SeqCst) != self.content {
            return Err(OpenRace::Republished);
        }
        Ok(())
    }
}

impl Drop for OpenAdmission {
    fn drop(&mut self) {
        let mut state = self.cell.lock_state();
        state.active_opens = state.active_opens.saturating_sub(1);
        drop(state);
        self.cell.changed.notify_all();
    }
}

/// One in-progress sidecar publication (trusted template re-analysis).
///
/// While it is alive, cold opens of the corpus wait and a discard drains it
/// before unpublishing the directory. Beginning and ending it both advance the
/// content generation, so handles opened before it are no longer current.
pub struct CorpusPublication {
    cell: Arc<CorpusLifecycle>,
    epoch: u64,
}

impl std::fmt::Debug for CorpusPublication {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CorpusPublication")
            .field("directory_id", &self.cell.directory_id)
            .field("epoch", &self.epoch)
            .finish()
    }
}

/// Begin a sidecar publication for `cache_root/log_corpora/{directory_id}`.
///
/// Fails with a [`LOG_CORPUS_DISCARDED`] error once a discard has begun.
pub fn begin_publication(cache_root: &Path, directory_id: &str) -> CoreResult<CorpusPublication> {
    let cell = lifecycle_for(cache_root, directory_id);
    let mut state = cell.lock_state();
    match state.phase {
        CorpusLifecyclePhase::Live => {}
        CorpusLifecyclePhase::Discarding => {
            return Err(discarded_error(directory_id, "discard in progress"))
        }
        CorpusLifecyclePhase::Discarded => {
            return Err(discarded_error(directory_id, "corpus no longer exists"))
        }
    }
    state.active_publications += 1;
    cell.content.fetch_add(1, Ordering::SeqCst);
    let epoch = cell.epoch.load(Ordering::SeqCst);
    drop(state);
    Ok(CorpusPublication { cell, epoch })
}

impl CorpusPublication {
    /// Fail once a discard fenced the corpus during this publication.
    pub fn ensure_live(&self) -> CoreResult<()> {
        if self.cell.epoch.load(Ordering::SeqCst) == self.epoch {
            Ok(())
        } else {
            Err(discarded_error(
                &self.cell.directory_id,
                "discarded while a re-analysis was publishing",
            ))
        }
    }

    /// Admit the publication's own validation reopen without waiting for
    /// itself. Still rejected once a discard has fenced the corpus.
    pub fn admit_open(&self) -> CoreResult<OpenAdmission> {
        self.cell.admit_open_inner(true)
    }
}

impl Drop for CorpusPublication {
    fn drop(&mut self) {
        let mut state = self.cell.lock_state();
        state.active_publications = state.active_publications.saturating_sub(1);
        self.cell.content.fetch_add(1, Ordering::SeqCst);
        drop(state);
        self.cell.changed.notify_all();
    }
}

/// Result of a successful discard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscardOutcome {
    /// False when the corpus directory was already absent (idempotent discard).
    pub unpublished: bool,
    /// Unlisted tree under `.discarding/` that could not be removed yet. The
    /// corpus is gone either way; later discards sweep this residue.
    pub residue: Option<PathBuf>,
}

/// Restores the pre-fence phase when a discard fails (or unwinds) before
/// unpublishing. Epoch advances are never undone: handles fenced by the
/// attempt stay stale and fresh opens receive the new epoch.
struct DiscardRollback<'a> {
    cell: &'a CorpusLifecycle,
    prior: CorpusLifecyclePhase,
    armed: bool,
}

impl DiscardRollback<'_> {
    fn publish_discarded(mut self) {
        self.armed = false;
        let mut state = self.cell.lock_state();
        state.phase = CorpusLifecyclePhase::Discarded;
        self.cell.tombstone.store(
            TOMBSTONE_AGE.fetch_add(1, Ordering::SeqCst) + 1,
            Ordering::SeqCst,
        );
        drop(state);
        self.cell.changed.notify_all();
    }
}

impl Drop for DiscardRollback<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self.cell.lock_state();
        if state.phase == CorpusLifecyclePhase::Discarding {
            state.phase = self.prior;
        }
        drop(state);
        self.cell.changed.notify_all();
    }
}

/// Discard `cache_root/log_corpora/{corpus_id}` as one fenced transition.
///
/// `corpus_id` must be a public corpus id (validated here as well, since this
/// function moves and deletes directories). `on_fenced` runs right after the
/// fence and `release_files` right after the drain, both before the directory
/// is unpublished and both with no lifecycle lock held: hosts use the first to
/// drop cached handles and detach in-flight cache initializations, the store
/// uses the second to close the corpus's shared DuckDB connection.
pub(crate) fn discard_corpus_root(
    cache_root: &Path,
    corpus_id: &str,
    on_fenced: impl FnOnce(),
    release_files: impl FnOnce(),
) -> CoreResult<DiscardOutcome> {
    discard_corpus_root_with(
        cache_root,
        corpus_id,
        on_fenced,
        release_files,
        &remove_tree,
    )
}

fn validate_public_corpus_id(id: &str) -> CoreResult<()> {
    let is_safe = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if is_safe {
        Ok(())
    } else {
        Err(CoreError::Message("invalid corpus id".into()))
    }
}

fn remove_tree(path: &Path) -> std::io::Result<()> {
    std::fs::remove_dir_all(path)
}

fn discard_corpus_root_with(
    cache_root: &Path,
    corpus_id: &str,
    on_fenced: impl FnOnce(),
    release_files: impl FnOnce(),
    remove_tree: &dyn Fn(&Path) -> std::io::Result<()>,
) -> CoreResult<DiscardOutcome> {
    validate_public_corpus_id(corpus_id)?;
    let cell = lifecycle_for(cache_root, corpus_id);

    // 1. Fence. Concurrent discards of the same corpus serialize here.
    let prior = {
        let state = cell.lock_state();
        let deadline = Instant::now() + DISCARD_DRAIN_WAIT;
        let mut state = cell
            .wait_until(state, deadline, |state| {
                state.phase != CorpusLifecyclePhase::Discarding
            })
            .map_err(|_| busy_error(corpus_id, "another discard is still running"))?;
        let prior = state.phase;
        state.phase = CorpusLifecyclePhase::Discarding;
        cell.epoch.fetch_add(1, Ordering::SeqCst);
        prior
    };
    // Wake phase observers and admission waiters: they must see the fence now.
    cell.changed.notify_all();
    let rollback = DiscardRollback {
        cell: &cell,
        prior,
        armed: true,
    };

    // 2. Invalidate host caches (no lifecycle lock held).
    on_fenced();

    // 3. Drain admitted cold opens and publications.
    {
        let state = cell.lock_state();
        let deadline = Instant::now() + DISCARD_DRAIN_WAIT;
        let drained = cell.wait_until(state, deadline, |state| {
            state.active_opens == 0 && state.active_publications == 0
        });
        if drained.is_err() {
            return Err(busy_error(
                corpus_id,
                "an open or re-analysis did not finish; nothing was deleted",
            ));
        }
    }

    // 4. Close this process's files in the directory (no lifecycle lock held).
    release_files();

    // 5. Unpublish atomically.
    let corpora = cache_root.join("log_corpora");
    let root = corpora.join(corpus_id);
    let tombstone = match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
        Ok(_) => unpublish(&corpora, &root, corpus_id)?,
    };

    // 6. Publish discard success, then reclaim space best-effort.
    rollback.publish_discarded();
    let residue = tombstone
        .as_deref()
        .and_then(|tombstone| reclaim(&corpora, tombstone, remove_tree));
    Ok(DiscardOutcome {
        unpublished: tombstone.is_some(),
        residue,
    })
}

fn unpublish(corpora: &Path, root: &Path, corpus_id: &str) -> CoreResult<Option<PathBuf>> {
    let trash = corpora.join(DISCARD_TRASH_DIR);
    let mut last_error = None;
    for _ in 0..UNPUBLISH_RENAME_ATTEMPTS {
        std::fs::create_dir_all(&trash)?;
        let tombstone = trash.join(format!(
            "{corpus_id}.{}.{}",
            std::process::id(),
            TOMBSTONE_SEQUENCE.fetch_add(1, Ordering::SeqCst)
        ));
        match std::fs::rename(root, &tombstone) {
            Ok(()) => return Ok(Some(tombstone)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(root).is_err() {
                    // Removed by someone else between the existence check and
                    // the rename: the corpus is gone, which is the goal.
                    return Ok(None);
                }
                // A concurrent sweep removed the empty trash directory; retry.
                last_error = Some(error);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(last_error
        .map(CoreError::from)
        .unwrap_or_else(|| busy_error(corpus_id, "could not move the corpus aside")))
}

fn reclaim(
    corpora: &Path,
    tombstone: &Path,
    remove_tree: &dyn Fn(&Path) -> std::io::Result<()>,
) -> Option<PathBuf> {
    let residue = match remove_tree(tombstone) {
        Ok(()) => None,
        Err(_) if std::fs::symlink_metadata(tombstone).is_err() => None,
        Err(_) => Some(tombstone.to_path_buf()),
    };
    let trash = corpora.join(DISCARD_TRASH_DIR);
    if let Ok(entries) = std::fs::read_dir(&trash) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != tombstone {
                let _ = remove_tree(&path);
            }
        }
    }
    // Leave no empty trash directory behind; fails harmlessly when non-empty.
    let _ = std::fs::remove_dir(&trash);
    residue
}

/// Process-wide registry of one shared resource per corpus key (for example
/// the single DuckDB connection per corpus database).
///
/// Initialization is single-flight **per key**: same-key callers wait for one
/// leader, different keys initialize concurrently, and the registry mutex is
/// never held while `open` runs (DuckDB open and schema initialization). Values
/// are held weakly, so a resource lives exactly as long as its handles.
pub(crate) struct SharedPerCorpus<T> {
    slots: Mutex<HashMap<PathBuf, SharedSlot<T>>>,
}

enum SharedSlot<T> {
    Ready(std::sync::Weak<T>),
    Opening(Arc<OpeningGate>),
}

struct OpeningGate {
    done: Mutex<bool>,
    finished: Condvar,
}

impl OpeningGate {
    fn finish(&self) {
        *self.done.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.finished.notify_all();
    }

    fn wait(&self) {
        let done = self.done.lock().unwrap_or_else(PoisonError::into_inner);
        let _done = self
            .finished
            .wait_while(done, |done| !*done)
            .unwrap_or_else(PoisonError::into_inner);
    }
}

enum SharedRole<T> {
    Ready(Arc<T>),
    Wait(Arc<OpeningGate>),
    Lead(Arc<OpeningGate>),
}

/// Releases a leader's gate on every exit path (success, error, unwind).
struct SharedLeader<'a, T> {
    registry: &'a SharedPerCorpus<T>,
    key: &'a Path,
    gate: Arc<OpeningGate>,
}

impl<T> Drop for SharedLeader<'_, T> {
    fn drop(&mut self) {
        {
            let mut slots = self.registry.lock_slots();
            let ours = matches!(
                slots.get(self.key),
                Some(SharedSlot::Opening(gate)) if Arc::ptr_eq(gate, &self.gate)
            );
            if ours {
                slots.remove(self.key);
            }
        }
        self.gate.finish();
    }
}

impl<T> SharedPerCorpus<T> {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    fn lock_slots(&self) -> MutexGuard<'_, HashMap<PathBuf, SharedSlot<T>>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Shared value for `key`, opening it once if no live value exists.
    pub(crate) fn get_or_open(
        &self,
        key: &Path,
        open: impl FnOnce() -> CoreResult<T>,
    ) -> CoreResult<Arc<T>> {
        let mut open = Some(open);
        loop {
            let role = {
                let mut slots = self.lock_slots();
                slots.retain(|_, slot| match slot {
                    SharedSlot::Ready(value) => value.strong_count() > 0,
                    SharedSlot::Opening(_) => true,
                });
                match slots.get(key) {
                    Some(SharedSlot::Ready(value)) => match value.upgrade() {
                        Some(value) => SharedRole::Ready(value),
                        None => {
                            let gate = Arc::new(OpeningGate {
                                done: Mutex::new(false),
                                finished: Condvar::new(),
                            });
                            slots.insert(key.to_path_buf(), SharedSlot::Opening(Arc::clone(&gate)));
                            SharedRole::Lead(gate)
                        }
                    },
                    Some(SharedSlot::Opening(gate)) => SharedRole::Wait(Arc::clone(gate)),
                    None => {
                        let gate = Arc::new(OpeningGate {
                            done: Mutex::new(false),
                            finished: Condvar::new(),
                        });
                        slots.insert(key.to_path_buf(), SharedSlot::Opening(Arc::clone(&gate)));
                        SharedRole::Lead(gate)
                    }
                }
            };
            match role {
                SharedRole::Ready(value) => return Ok(value),
                // The leader finished (published or failed); look again.
                SharedRole::Wait(gate) => gate.wait(),
                SharedRole::Lead(gate) => {
                    let leader = SharedLeader {
                        registry: self,
                        key,
                        gate,
                    };
                    let Some(open) = open.take() else {
                        return Err(CoreError::Message(
                            "shared corpus resource initializer already consumed".into(),
                        ));
                    };
                    let value = Arc::new(open()?);
                    self.lock_slots()
                        .insert(key.to_path_buf(), SharedSlot::Ready(Arc::downgrade(&value)));
                    drop(leader);
                    return Ok(value);
                }
            }
        }
    }

    /// Live value for `key`, if any, without initializing one.
    pub(crate) fn get(&self, key: &Path) -> Option<Arc<T>> {
        match self.lock_slots().get(key) {
            Some(SharedSlot::Ready(value)) => value.upgrade(),
            _ => None,
        }
    }

    /// Retire `key` only while it still maps to exactly `expected`, so a
    /// discard can close that value; later lookups initialize a fresh one. An
    /// in-progress initialization is never removed (discard drains every
    /// admitted open before it releases files, so none is expected).
    pub(crate) fn detach(&self, key: &Path, expected: &Arc<T>) -> bool {
        let mut slots = self.lock_slots();
        let matches = matches!(
            slots.get(key),
            Some(SharedSlot::Ready(value)) if std::ptr::eq(value.as_ptr(), Arc::as_ptr(expected))
        );
        if matches {
            slots.remove(key);
        }
        matches
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    const WAIT: Duration = Duration::from_secs(10);
    /// Bounded observation window: a correct discard stays blocked for any
    /// duration, so this can only expose a missing drain, never cause a
    /// spurious failure.
    const DRAIN_OBSERVATION: Duration = Duration::from_millis(150);

    fn corpus_dir(cache: &Path, id: &str) -> PathBuf {
        let root = cache.join("log_corpora").join(id);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("meta.json"), b"{}").unwrap();
        root
    }

    fn opened_ticket(cache: &Path, id: &str) -> CorpusLifecycleTicket {
        let admission = lifecycle_for(cache, id).admit_open().unwrap();
        let ticket = admission.ticket();
        admission.finish().unwrap();
        ticket
    }

    fn discard(cache: &Path, id: &str, on_fenced: impl FnOnce()) -> CoreResult<DiscardOutcome> {
        discard_corpus_root(cache, id, on_fenced, || {})
    }

    fn assert_discarded(error: &CoreError) {
        assert!(
            is_corpus_discarded_error(error),
            "expected a discard-fence error, got: {error}"
        );
    }

    #[test]
    fn discard_success_is_published_only_after_every_handle_is_stale() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "c-1");
        let retained = opened_ticket(cache.path(), "c-1");
        let other = opened_ticket(cache.path(), "c-2");
        assert!(retained.is_live() && retained.is_current());

        let fenced_view = std::cell::Cell::new(None);
        let outcome = discard(cache.path(), "c-1", || {
            // Inside the transition: already fenced, still on disk.
            fenced_view.set(Some((retained.is_live(), root.exists())));
        })
        .unwrap();

        assert_eq!(fenced_view.get(), Some((false, true)));
        assert_eq!(
            outcome,
            DiscardOutcome {
                unpublished: true,
                residue: None
            }
        );
        assert!(!root.exists(), "corpus directory must be gone");
        assert!(
            !cache
                .path()
                .join("log_corpora")
                .join(DISCARD_TRASH_DIR)
                .exists(),
            "successful reclaim leaves no trash directory"
        );
        assert!(!retained.is_live());
        assert!(!retained.is_current());
        assert_discarded(&retained.ensure_live().unwrap_err());
        assert_discarded(&lifecycle_for(cache.path(), "c-1").admit_open().unwrap_err());
        assert_discarded(&begin_publication(cache.path(), "c-1").unwrap_err());
        // Negative control: an unrelated corpus is untouched.
        assert!(other.is_live() && other.is_current());
        assert!(other.ensure_live().is_ok());
    }

    #[test]
    fn open_admitted_before_the_fence_blocks_unpublish_and_cannot_publish_a_handle() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "race-open");
        let cell = lifecycle_for(cache.path(), "race-open");
        // A cold open has been admitted and is "reading files".
        let admission = cell.admit_open().unwrap();
        let provisional = admission.ticket();

        let (fenced_tx, fenced_rx) = mpsc::channel();
        let cache_root = cache.path().to_path_buf();
        let discard = std::thread::spawn(move || {
            discard(&cache_root, "race-open", move || {
                fenced_tx.send(()).unwrap();
            })
        });
        fenced_rx
            .recv_timeout(WAIT)
            .expect("discard reached its fence");
        assert_eq!(cell.phase(), CorpusLifecyclePhase::Discarding);
        assert_eq!(cell.active_sections(), (1, 0));
        // The admitted open is still running: however long we wait, discard
        // must not finish or unpublish (it is blocked in its drain).
        std::thread::sleep(DRAIN_OBSERVATION);
        assert!(
            !discard.is_finished(),
            "discard must wait for admitted opens"
        );
        assert!(root.exists(), "discard must drain admitted opens first");
        assert!(!provisional.is_live(), "the fence precedes completion");
        assert_discarded(&cell.admit_open().unwrap_err());

        match admission.finish() {
            Err(OpenRace::Discarded(error)) => assert_discarded(&error),
            other => panic!("racing open must be rejected, got {other:?}"),
        }
        let outcome = discard.join().unwrap().unwrap();
        assert!(outcome.unpublished);
        assert!(!root.exists());
        assert_eq!(cell.phase(), CorpusLifecyclePhase::Discarded);
        assert_eq!(cell.active_sections(), (0, 0));
    }

    #[test]
    fn failed_open_releases_its_admission_so_discard_can_finish() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "open-error");
        let cell = lifecycle_for(cache.path(), "open-error");
        let admission = cell.admit_open().unwrap();
        let (fenced_tx, fenced_rx) = mpsc::channel();
        let cache_root = cache.path().to_path_buf();
        let discard = std::thread::spawn(move || {
            discard(&cache_root, "open-error", move || {
                fenced_tx.send(()).unwrap();
            })
        });
        fenced_rx.recv_timeout(WAIT).unwrap();
        std::thread::sleep(DRAIN_OBSERVATION);
        assert!(
            !discard.is_finished(),
            "an unfinished admission blocks discard"
        );
        assert!(root.exists());
        // Open fails (e.g. schema error) and drops its admission unfinished.
        drop(admission);
        assert!(discard.join().unwrap().unwrap().unpublished);
        assert!(!root.exists());
    }

    #[test]
    fn publication_is_drained_and_opens_wait_for_it_without_reading_half_state() {
        let cache = tempfile::tempdir().unwrap();
        corpus_dir(cache.path(), "pub");
        let before = opened_ticket(cache.path(), "pub");
        let publication = begin_publication(cache.path(), "pub").unwrap();
        assert!(before.is_live(), "publication never fences");
        assert!(!before.is_current(), "republished handles must reopen");

        let (opened_tx, opened_rx) = mpsc::channel();
        let cache_root = cache.path().to_path_buf();
        let opener = std::thread::spawn(move || {
            let admission = lifecycle_for(&cache_root, "pub").admit_open().unwrap();
            let ticket = admission.ticket();
            admission.finish().unwrap();
            opened_tx.send(()).unwrap();
            ticket
        });
        assert!(
            opened_rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "an open must wait while a publication is in flight"
        );
        // The publication's own validation reopen does not wait for itself.
        let validation = publication.admit_open().unwrap();
        validation.finish().unwrap();
        drop(publication);
        opened_rx
            .recv_timeout(WAIT)
            .expect("open admitted after publish");
        let after = opener.join().unwrap();
        assert!(after.is_current());
        assert!(!before.is_current());
    }

    #[test]
    fn open_overlapping_a_publication_start_must_reopen() {
        let cache = tempfile::tempdir().unwrap();
        corpus_dir(cache.path(), "republish");
        let cell = lifecycle_for(cache.path(), "republish");
        let admission = cell.admit_open().unwrap();
        let publication = begin_publication(cache.path(), "republish").unwrap();
        assert!(matches!(admission.finish(), Err(OpenRace::Republished)));
        drop(publication);
    }

    #[test]
    fn discard_fences_publication_and_waits_for_it_to_end() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "pub-discard");
        let publication = begin_publication(cache.path(), "pub-discard").unwrap();
        let (fenced_tx, fenced_rx) = mpsc::channel();
        let cache_root = cache.path().to_path_buf();
        let discard = std::thread::spawn(move || {
            discard(&cache_root, "pub-discard", move || {
                fenced_tx.send(()).unwrap();
            })
        });
        fenced_rx.recv_timeout(WAIT).unwrap();
        assert_discarded(&publication.ensure_live().unwrap_err());
        assert_discarded(&publication.admit_open().unwrap_err());
        std::thread::sleep(DRAIN_OBSERVATION);
        assert!(
            !discard.is_finished(),
            "discard must wait for the publication"
        );
        assert!(root.exists(), "discard drains the publication first");
        drop(publication);
        assert!(discard.join().unwrap().unwrap().unpublished);
        assert!(!root.exists());
    }

    #[test]
    fn unpublish_failure_rolls_back_to_live_and_retry_succeeds() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "rollback");
        let stale = opened_ticket(cache.path(), "rollback");
        // Make the trash location unusable: a regular file named `.discarding`.
        let trash = cache.path().join("log_corpora").join(DISCARD_TRASH_DIR);
        std::fs::write(&trash, b"not a directory").unwrap();

        let error = discard(cache.path(), "rollback", || {}).unwrap_err();
        assert!(!is_corpus_discarded_error(&error), "io failure: {error}");
        assert!(root.exists(), "nothing was deleted");
        let cell = lifecycle_for(cache.path(), "rollback");
        assert_eq!(cell.phase(), CorpusLifecyclePhase::Live, "rolled back");
        assert!(!stale.is_live(), "handles fenced by the attempt stay stale");
        let stale_error = stale.ensure_live().unwrap_err();
        assert!(
            !is_corpus_discarded_error(&stale_error),
            "a rolled-back discard must not claim the corpus was discarded: {stale_error}"
        );
        assert!(
            stale_error.to_string().contains("still exists"),
            "{stale_error}"
        );
        let fresh = opened_ticket(cache.path(), "rollback");
        assert!(fresh.is_live(), "fresh opens after rollback are live");

        std::fs::remove_file(&trash).unwrap();
        let outcome = discard(cache.path(), "rollback", || {}).unwrap();
        assert!(outcome.unpublished);
        assert!(!root.exists());
        assert!(!fresh.is_live());
    }

    #[test]
    fn panicking_invalidation_hook_rolls_back_instead_of_wedging_the_corpus() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "hook-panic");
        let cache_root = cache.path().to_path_buf();
        let result = std::panic::catch_unwind(move || {
            let _ = discard(&cache_root, "hook-panic", || panic!("injected hook"));
        });
        assert!(result.is_err());
        assert!(root.exists());
        let cell = lifecycle_for(cache.path(), "hook-panic");
        assert_eq!(cell.phase(), CorpusLifecyclePhase::Live);
        assert!(
            discard(cache.path(), "hook-panic", || {})
                .unwrap()
                .unpublished
        );
    }

    #[test]
    fn reclaim_failure_leaves_only_unlisted_residue_and_next_discard_sweeps_it() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "residue-a");
        let outcome = discard_corpus_root_with(cache.path(), "residue-a", || {}, || {}, &|_| {
            Err(std::io::Error::other("injected removal failure"))
        })
        .unwrap();
        assert!(outcome.unpublished, "the corpus itself is gone");
        assert!(!root.exists());
        let residue = outcome.residue.expect("residue reported");
        assert!(residue.starts_with(cache.path().join("log_corpora").join(DISCARD_TRASH_DIR)));
        assert!(residue.exists());
        assert_eq!(
            lifecycle_for(cache.path(), "residue-a").phase(),
            CorpusLifecyclePhase::Discarded
        );

        corpus_dir(cache.path(), "residue-b");
        let next = discard(cache.path(), "residue-b", || {}).unwrap();
        assert_eq!(next.residue, None);
        assert!(!residue.exists(), "older residue swept");
        assert!(!cache
            .path()
            .join("log_corpora")
            .join(DISCARD_TRASH_DIR)
            .exists());
    }

    #[test]
    fn discard_of_absent_corpus_is_idempotent_and_still_fences() {
        let cache = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(cache.path().join("log_corpora")).unwrap();
        let ghost = opened_ticket(cache.path(), "ghost");
        let outcome = discard(cache.path(), "ghost", || {}).unwrap();
        assert_eq!(
            outcome,
            DiscardOutcome {
                unpublished: false,
                residue: None
            }
        );
        assert!(!ghost.is_live());
        let again = discard(cache.path(), "ghost", || {}).unwrap();
        assert!(!again.unpublished);
    }

    #[test]
    fn concurrent_discards_serialize_and_both_report_success() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "twice");
        let (fenced_tx, fenced_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let first_root = cache.path().to_path_buf();
        let first = std::thread::spawn(move || {
            discard(&first_root, "twice", move || {
                fenced_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
            })
        });
        fenced_rx.recv_timeout(WAIT).unwrap();
        let second_root = cache.path().to_path_buf();
        let (second_done_tx, second_done_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let result = discard(&second_root, "twice", || {});
            second_done_tx.send(()).unwrap();
            result
        });
        assert!(
            second_done_rx
                .recv_timeout(Duration::from_millis(150))
                .is_err(),
            "second discard waits for the first transition"
        );
        release_tx.send(()).unwrap();
        assert!(first.join().unwrap().unwrap().unpublished);
        let second = second.join().unwrap().unwrap();
        assert!(!second.unpublished, "already gone");
        assert!(!root.exists());
    }

    #[test]
    fn registry_prunes_unreferenced_cells_but_keeps_referenced_ones() {
        let cache = tempfile::tempdir().unwrap();
        corpus_dir(cache.path(), "prune");
        let held = opened_ticket(cache.path(), "prune");
        let same = lifecycle_for(cache.path(), "prune");
        assert!(Arc::ptr_eq(held.lifecycle(), &same), "one cell per corpus");
        let observed = Arc::downgrade(&same);
        // Still referenced by `held`: a lookup must not prune it.
        drop(same);
        let _ = lifecycle_for(cache.path(), "prune-other");
        assert!(observed.upgrade().is_some(), "referenced cell retained");
        drop(held);
        // Unreferenced live cell: the next lookup prunes it from the registry.
        let _ = lifecycle_for(cache.path(), "prune-other");
        assert!(
            observed.upgrade().is_none(),
            "unreferenced live cell pruned"
        );
        let fresh = lifecycle_for(cache.path(), "prune");
        assert_eq!(fresh.phase(), CorpusLifecyclePhase::Live);
        assert!(fresh.wait_for_phase(CorpusLifecyclePhase::Live, WAIT));
    }

    #[test]
    fn tombstone_outlives_every_handle_so_late_opens_still_report_discarded() {
        let cache = tempfile::tempdir().unwrap();
        corpus_dir(cache.path(), "late-open");
        let ticket = opened_ticket(cache.path(), "late-open");
        discard(cache.path(), "late-open", || {}).unwrap();
        drop(ticket);
        // Force pruning passes; the tombstone is retained without referents.
        let _ = lifecycle_for(cache.path(), "other-lookup");
        let cell = lifecycle_for(cache.path(), "late-open");
        assert_eq!(cell.phase(), CorpusLifecyclePhase::Discarded);
        assert_discarded(&cell.admit_open().unwrap_err());
        // Re-discard of a tombstone is idempotent and keeps it discarded.
        drop(cell);
        let again = discard(cache.path(), "late-open", || {}).unwrap();
        assert!(!again.unpublished);
        assert_eq!(
            lifecycle_for(cache.path(), "late-open").phase(),
            CorpusLifecyclePhase::Discarded
        );
    }

    #[test]
    fn retained_tombstones_are_bounded_oldest_first() {
        // A private registry: pruning the global one here could evict other
        // parallel tests' tombstones.
        let mut cells = HashMap::new();
        let held = Arc::new(CorpusLifecycle::new("held"));
        held.tombstone.store(1, Ordering::SeqCst);
        cells.insert(PathBuf::from("/held"), Arc::clone(&held));
        cells.insert(
            PathBuf::from("/idle-live"),
            Arc::new(CorpusLifecycle::new("idle-live")),
        );
        for age in 2..=6 {
            let cell = CorpusLifecycle::new(&format!("t{age}"));
            cell.tombstone.store(age, Ordering::SeqCst);
            cells.insert(PathBuf::from(format!("/t{age}")), Arc::new(cell));
        }
        prune_registry_with_cap(&mut cells, 3);
        let mut kept: Vec<_> = cells
            .keys()
            .map(|key| key.to_string_lossy().into_owned())
            .collect();
        kept.sort();
        assert_eq!(
            kept,
            vec!["/held", "/t4", "/t5", "/t6"],
            "idle live cells go first, then the oldest idle tombstones; referenced \
             cells are never pruned"
        );
        drop(held);
    }

    #[test]
    fn discarded_message_classifier_matches_only_fence_errors() {
        assert!(is_corpus_discarded_message(
            "log corpus was discarded: c (discard in progress)"
        ));
        assert!(!is_corpus_discarded_message("corpus not found: c"));
        assert!(!is_corpus_discarded_error(&CoreError::Policy(
            "log corpus was discarded".into()
        )));
    }

    #[test]
    fn files_are_released_after_the_drain_and_before_unpublish() {
        let cache = tempfile::tempdir().unwrap();
        let root = corpus_dir(cache.path(), "release-order");
        let cell = lifecycle_for(cache.path(), "release-order");
        let admission = cell.admit_open().unwrap();
        let (fenced_tx, fenced_rx) = mpsc::channel();
        let (released_tx, released_rx) = mpsc::channel();
        let cache_root = cache.path().to_path_buf();
        let release_cell = Arc::clone(&cell);
        let release_root = root.clone();
        let discard = std::thread::spawn(move || {
            discard_corpus_root(
                &cache_root,
                "release-order",
                move || fenced_tx.send(()).unwrap(),
                move || {
                    released_tx
                        .send((release_root.exists(), release_cell.active_sections()))
                        .unwrap();
                },
            )
        });
        fenced_rx.recv_timeout(WAIT).unwrap();
        assert!(
            released_rx.recv_timeout(DRAIN_OBSERVATION).is_err(),
            "files must not be released while an admitted open runs"
        );
        drop(admission);
        let (root_present, sections) = released_rx.recv_timeout(WAIT).unwrap();
        assert!(root_present, "release happens before unpublish");
        assert_eq!(sections, (0, 0), "release happens after the drain");
        assert!(discard.join().unwrap().unwrap().unpublished);
        assert!(!root.exists());
    }

    #[test]
    fn fence_wakes_phase_observers_without_waiting_for_their_timeout() {
        let cache = tempfile::tempdir().unwrap();
        corpus_dir(cache.path(), "wake");
        let cell = lifecycle_for(cache.path(), "wake");
        // A publication keeps the discard blocked in its drain, so only the
        // fence itself can wake the observer.
        let publication = begin_publication(cache.path(), "wake").unwrap();
        let observer_cell = Arc::clone(&cell);
        let observer = std::thread::spawn(move || {
            let started = Instant::now();
            let reached = observer_cell.wait_for_phase(CorpusLifecyclePhase::Discarding, WAIT);
            (reached, started.elapsed())
        });
        std::thread::sleep(DRAIN_OBSERVATION);
        let cache_root = cache.path().to_path_buf();
        let discard = std::thread::spawn(move || discard(&cache_root, "wake", || {}));
        let (reached, waited) = observer.join().unwrap();
        assert!(reached);
        assert!(
            waited < WAIT / 2,
            "the fence must notify observers (waited {waited:?})"
        );
        drop(publication);
        assert!(discard.join().unwrap().unwrap().unpublished);
    }

    #[test]
    fn discard_rejects_ids_that_could_escape_log_corpora() {
        let cache = tempfile::tempdir().unwrap();
        let outside = cache.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(cache.path().join("log_corpora")).unwrap();
        for id in ["", "../outside", "a/b", ".discarding", "..", "x\\y"] {
            assert!(discard(cache.path(), id, || {}).is_err(), "{id:?}");
        }
        assert!(outside.exists(), "nothing outside log_corpora is touched");
    }

    fn shared_registry() -> Arc<SharedPerCorpus<usize>> {
        Arc::new(SharedPerCorpus::new())
    }

    #[test]
    fn shared_registry_coalesces_same_key_and_keeps_keys_independent() {
        let registry = shared_registry();
        let opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let leader_registry = Arc::clone(&registry);
        let leader_opens = Arc::clone(&opens);
        let leader = std::thread::spawn(move || {
            leader_registry.get_or_open(Path::new("/slow"), move || {
                leader_opens.fetch_add(1, Ordering::SeqCst);
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(WAIT).unwrap();
                Ok(7)
            })
        });
        entered_rx.recv_timeout(WAIT).unwrap();

        // A different key initializes while "/slow" is mid-open.
        let (other_tx, other_rx) = mpsc::channel();
        let other_registry = Arc::clone(&registry);
        std::thread::spawn(move || {
            let value = other_registry
                .get_or_open(Path::new("/fast"), || Ok(1))
                .unwrap();
            other_tx.send(*value).unwrap();
        });
        assert_eq!(
            other_rx
                .recv_timeout(WAIT)
                .expect("independent key not blocked"),
            1
        );

        // Same key waits for the leader instead of opening again.
        let waiter_registry = Arc::clone(&registry);
        let waiter_opens = Arc::clone(&opens);
        let waiter = std::thread::spawn(move || {
            waiter_registry.get_or_open(Path::new("/slow"), move || {
                waiter_opens.fetch_add(1, Ordering::SeqCst);
                Ok(99)
            })
        });
        std::thread::sleep(DRAIN_OBSERVATION);
        assert!(
            !waiter.is_finished(),
            "same-key caller waits for the leader"
        );
        release_tx.send(()).unwrap();
        let led = leader.join().unwrap().unwrap();
        let joined = waiter.join().unwrap().unwrap();
        assert!(Arc::ptr_eq(&led, &joined), "one shared value per key");
        assert_eq!(opens.load(Ordering::SeqCst), 1, "exactly one open");
    }

    #[test]
    fn shared_registry_failure_and_panic_release_the_key_for_retry() {
        let registry = shared_registry();
        let error = registry
            .get_or_open(Path::new("/k"), || Err(CoreError::Message("boom".into())))
            .unwrap_err();
        assert_eq!(error.to_string(), "boom");
        assert_eq!(*registry.get_or_open(Path::new("/k"), || Ok(2)).unwrap(), 2);

        let panicking = Arc::clone(&registry);
        let panicked = std::thread::spawn(move || {
            let _ = panicking.get_or_open(Path::new("/p"), || -> CoreResult<usize> {
                panic!("injected open panic")
            });
        })
        .join();
        assert!(panicked.is_err());
        assert_eq!(*registry.get_or_open(Path::new("/p"), || Ok(3)).unwrap(), 3);
    }

    #[test]
    fn shared_registry_detach_retires_only_the_expected_value() {
        let registry = shared_registry();
        let first = registry.get_or_open(Path::new("/t"), || Ok(1)).unwrap();
        let peeked = registry.get(Path::new("/t")).expect("live value");
        assert!(Arc::ptr_eq(&first, &peeked), "get never initializes anew");
        let unrelated = Arc::new(1);
        assert!(
            !registry.detach(Path::new("/t"), &unrelated),
            "a different value (equal contents) is not retired"
        );
        assert!(registry.detach(Path::new("/t"), &first));
        assert!(registry.get(Path::new("/t")).is_none());
        let fresh = registry.get_or_open(Path::new("/t"), || Ok(2)).unwrap();
        assert_eq!(*fresh, 2, "a retired value is never handed out again");
        assert!(!registry.detach(Path::new("/t"), &first), "already retired");
        drop((first, peeked, fresh));
        assert!(registry.get(Path::new("/t")).is_none(), "dead value");
    }
}
