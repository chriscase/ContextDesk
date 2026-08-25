/**
 * Best-effort, in-process idempotency cache for admin mutation routes whose
 * underlying operation is CAS-guarded (status changes: a retry with the
 * same expectedRevision would otherwise fail as stale_revision the second
 * time, even though the caller only intended one logical change).
 *
 * Deliberately NOT durable across a restart and NOT shared across process
 * instances: the underlying mutations (grant/revoke via a unique
 * constraint, status via CAS) are already safe to retry at the data layer
 * on their own. This cache's job is narrower - returning byte-identical
 * responses on retry and preventing duplicate audit-log entries within one
 * process's lifetime - not acting as a source of truth.
 */
export interface CachedResponse {
  status: number;
  body: unknown;
}

interface Entry extends CachedResponse {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5_000;

export class IdempotencyCache {
  private readonly byKey = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  private prune(now: number): void {
    for (const [key, entry] of this.byKey) {
      if (entry.expiresAt <= now) this.byKey.delete(key);
    }
    while (this.byKey.size > MAX_ENTRIES) {
      const oldest = this.byKey.keys().next();
      if (oldest.done) break;
      this.byKey.delete(oldest.value);
    }
  }

  get(scopeKey: string): CachedResponse | undefined {
    const entry = this.byKey.get(scopeKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.byKey.delete(scopeKey);
      return undefined;
    }
    return { status: entry.status, body: entry.body };
  }

  set(scopeKey: string, response: CachedResponse): void {
    const now = Date.now();
    this.prune(now);
    this.byKey.set(scopeKey, { ...response, expiresAt: now + this.ttlMs });
  }
}
