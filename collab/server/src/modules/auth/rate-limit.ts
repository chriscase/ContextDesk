export interface RateLimiter {
  tooMany(key: string): boolean;
  fail(key: string): void;
  reset(key: string): void;
}

export function createRateLimiter(opts: {
  maxFails: number;
  windowMs: number;
}): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    tooMany(key: string): boolean {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
      hits.set(key, recent);
      return recent.length >= opts.maxFails;
    },
    fail(key: string): void {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
      recent.push(now);
      hits.set(key, recent);
    },
    reset(key: string): void {
      hits.delete(key);
    },
  };
}
