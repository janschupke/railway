/**
 * Single-consumer async queue.
 *
 * Lets several independent producers (a poll loop and a WebSocket subscription, say)
 * feed one `for await` without either blocking the other. `push` never awaits, so a
 * slow consumer cannot stall a producer; `end` drains what is already queued before the
 * iterator finishes.
 */
export class AsyncQueue<T> {
  #items: T[] = [];
  #resolvers: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  push(item: T): void {
    if (this.#ended) return;
    const resolve = this.#resolvers.shift();
    if (resolve) {
      resolve({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
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
