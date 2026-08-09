/**
 * Tracks public operations that must be allowed to finish before a resource
 * owner shuts down. The registry observes rejections only for bookkeeping;
 * the promise returned from run() remains the caller's original result.
 */
class ActiveOperationRegistry {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly drainWaiters = new Set<() => void>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(operation());
    } catch (error) {
      promise = Promise.reject(error);
    }

    this.operations.add(promise);
    void promise
      .finally(() => {
        this.operations.delete(promise);
        if (this.operations.size === 0) {
          const waiters = [...this.drainWaiters];
          this.drainWaiters.clear();
          for (const resolve of waiters) resolve();
        }
      })
      .catch(() => {
        // The original promise carries the rejection to its caller. This
        // observer must be handled to avoid an unhandled rejection of finally().
      });
    return promise;
  }

  drain(): Promise<void> {
    if (this.operations.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  get size(): number {
    return this.operations.size;
  }
}

export default ActiveOperationRegistry;
