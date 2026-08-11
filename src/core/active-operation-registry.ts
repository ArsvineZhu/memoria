import { AsyncLocalStorage } from "node:async_hooks";

import { MemoriaError } from "../errors.js";

interface ActiveOperationContext {
  active: true;
}

/**
 * Tracks public operations that must be allowed to finish before a resource
 * owner shuts down. The registry observes rejections only for bookkeeping;
 * the promise returned from run() remains the caller's original result.
 */
class ActiveOperationRegistry {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly drainWaiters = new Set<() => void>();
  private readonly operationContext = new AsyncLocalStorage<ActiveOperationContext>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = this.operationContext.run({ active: true }, () =>
        Promise.resolve(operation()),
      );
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
    this.assertNotInActiveOperation("drain");
    if (this.operations.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  assertNotInActiveOperation(operation: string): void {
    if (!this.operationContext.getStore()?.active) return;
    throw new MemoriaError(
      "concurrency",
      `Cannot ${operation} from within an active operation.`,
      {
        details: {
          reason: "active_operation_reentrancy",
          operation,
        },
      },
    );
  }

  get size(): number {
    return this.operations.size;
  }
}

export default ActiveOperationRegistry;
