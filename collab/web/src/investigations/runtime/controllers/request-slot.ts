const requestTokenBrand: unique symbol = Symbol("request-token");

/**
 * An opaque request identity. Consumers may use its scope and signal, but only
 * the slot that issued it can decide whether completion is still current.
 */
export interface RequestToken<TScope> {
  readonly scope: TScope;
  readonly signal: AbortSignal;
  readonly [requestTokenBrand]: true;
}

interface StoredRequestToken<TScope> extends RequestToken<TScope> {
  readonly generation: number;
}

/** A non-React cancellation and stale-publication fence for one request lane. */
export class RequestSlot<TScope> {
  private generation = 0;
  private active: StoredRequestToken<TScope> | undefined;

  begin(scope: TScope): RequestToken<TScope> {
    if (this.active !== undefined && !this.active.signal.aborted) {
      this.abortActive();
    }

    const controller = new AbortController();
    const token: StoredRequestToken<TScope> = Object.freeze({
      scope,
      signal: controller.signal,
      generation: ++this.generation,
      [requestTokenBrand]: true,
    });
    this.controllers.set(token, controller);
    this.active = token;
    return token;
  }

  isCurrent(token: RequestToken<TScope>): boolean {
    return this.active === token
      && this.active.generation === this.generation
      && !token.signal.aborted;
  }

  invalidate(): void {
    this.abortActive();
    this.generation += 1;
    this.active = undefined;
  }

  dispose(): void {
    this.invalidate();
  }

  private readonly controllers = new WeakMap<RequestToken<TScope>, AbortController>();

  private abortActive(): void {
    if (this.active === undefined) return;
    this.controllers.get(this.active)?.abort();
    this.controllers.delete(this.active);
  }
}
