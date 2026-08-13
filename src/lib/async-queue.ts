/**
 * Single-consumer async queue, bounded.
 *
 * Lets several independent producers (a poll loop and a WebSocket subscription, say)
 * feed one `for await` without either blocking the other. `push` never awaits, so a
 * slow consumer cannot stall a producer; `end` drains what is already queued before the
 * iterator finishes.
 *
 * "`push` never awaits" is also the reason for `maxQueued`: without a bound it is the
 * same sentence as "the buffer is unbounded". A chatty container behind a stalled TCP
 * receiver grew this array in the server process with nothing to stop it, while the only
 * cap in the system — STREAM.MAX_BUFFERED_LINES — lived in the browser, on the far side
 * of the socket that was not draining.
 */
export class AsyncQueue<T> {
  #items: T[] = [];
  #resolvers: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;
  #dropped = 0;
  readonly #maxQueued: number;

  /** @param maxQueued Items buffered for a consumer that is not keeping up. */
  constructor(maxQueued = Number.POSITIVE_INFINITY) {
    this.#maxQueued = maxQueued;
  }

  push(item: T): void {
    if (this.#ended) return;
    const resolve = this.#resolvers.shift();
    if (resolve) {
      resolve({ value: item, done: false });
      return;
    }
    /*
     * Drop the oldest, not the newest. A log tail's value is at its end: the lines that
     * say why a build failed are the ones that arrived last, and discarding those to
     * preserve the start of a buffer nobody is reading inverts the point of the pane.
     */
    if (this.#items.length >= this.#maxQueued) {
      this.#items.shift();
      this.#dropped += 1;
    }
    this.#items.push(item);
  }

  /** Items discarded because the consumer was not keeping up. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Stop accepting items. Anything already queued is still yielded. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const resolve of this.#resolvers) {
      resolve({ value: undefined, done: true });
    }
    this.#resolvers = [];
  }

  get ended(): boolean {
    return this.#ended;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const buffered = this.#items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.#ended) return;

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#resolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
