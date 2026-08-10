import { AsyncLocalStorage } from "node:async_hooks";

import { MemoriaError } from "../errors.js";

type AsyncTask<T> = () => T | Promise<T>;
type Phase = "read" | "mutation" | "reconcile";
type ActivePhase = Phase | "idle";

interface PhaseContext {
  phase: Phase;
}

/**
 * Coordinates concurrent authority mutations with reads and derived-index
 * reconciliation. Stable reads share a read phase, while different mutation
 * keys share a mutation phase. Reconciliation remains exclusive to both.
 */
class DerivedStateCoordinator {
  private readonly _reconcileTask: AsyncTask<void>;
  private readonly _mutationTails = new Map<string, Promise<void>>();
  private readonly _phaseContext = new AsyncLocalStorage<PhaseContext>();
  private _phase: ActivePhase = "idle";
  private _activeReaders = 0;
  private _activeMutations = 0;
  private _pendingReaders = 0;
  private _queuedMutations = 0;
  private _pendingReconciles = 0;
  private _phaseWaiters: Array<() => void> = [];
  private _reconcilePromise: Promise<void> | null = null;
  private _mutationEpoch = 0;
  private _reconciledEpoch = 0;
  private _vectorMutationFailed = false;

  constructor(reconcileTask: AsyncTask<void>) {
    this._reconcileTask = reconcileTask;
  }

  get isDirty(): boolean {
    return this._vectorMutationFailed;
  }

  get activeMutations(): number {
    return this._activeMutations;
  }

  get mutationEpoch(): number {
    return this._mutationEpoch;
  }

  get reconciledEpoch(): number {
    return this._reconciledEpoch;
  }

  /** Serialize one logical document while allowing other keys to proceed. */
  async runMutation<T>(
    key: string,
    task: (epoch: number) => T | Promise<T>,
  ): Promise<T> {
    this._assertNoConflictingReentry("mutation");
    this._queuedMutations += 1;

    const normalizedKey = key || "__default__";
    const previous = this._mutationTails.get(normalizedKey) ?? Promise.resolve();
    const run = previous.then(async () => {
      let queueTicketConsumed = false;
      try {
        for (;;) {
          await this._ensureClean();
          const release = await this._acquireMutation();
          queueTicketConsumed = true;
          if (this._vectorMutationFailed) {
            release();
            await this._ensureClean();
            this._queuedMutations += 1;
            continue;
          }

          const epoch = ++this._mutationEpoch;
          try {
            return await this._phaseContext.run({ phase: "mutation" }, () =>
              task(epoch),
            );
          } catch (error) {
            this._vectorMutationFailed = true;
            throw error;
          } finally {
            release();
          }
        }
      } finally {
        if (!queueTicketConsumed) this._queuedMutations -= 1;
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this._mutationTails.set(normalizedKey, tail);
    void tail.then(() => {
      if (this._mutationTails.get(normalizedKey) === tail) {
        this._mutationTails.delete(normalizedKey);
      }
    });
    return run;
  }

  /** Execute a read against a mutation-free and reconciled derived state. */
  async runStableRead<T>(task: AsyncTask<T>): Promise<T> {
    const current = this._phaseContext.getStore();
    if (current?.phase === "read") {
      return this._phaseContext.run(current, task);
    }
    this._assertNoConflictingReentry("read");

    for (;;) {
      await this._ensureClean();
      const release = await this._acquireRead();
      if (this._vectorMutationFailed) {
        release();
        continue;
      }
      try {
        return await this._phaseContext.run({ phase: "read" }, task);
      } finally {
        release();
      }
    }
  }

  /** Force a full reconciliation, even when the coordinator is currently clean. */
  reconcile(): Promise<void> {
    this._assertNoConflictingReentry("reconcile");
    if (this._reconcilePromise) return this._reconcilePromise;

    const reconciliation = this._runReconciliation();
    let tracked!: Promise<void>;
    tracked = reconciliation.finally(() => {
      if (this._reconcilePromise === tracked) this._reconcilePromise = null;
    });
    this._reconcilePromise = tracked;
    return tracked;
  }

  /** Mark a successfully restored or externally verified vector state clean. */
  markClean(): void {
    this._vectorMutationFailed = false;
    this._reconciledEpoch = this._mutationEpoch;
  }

  /** Preserve dirty state when an external recovery step fails. */
  markDirty(): void {
    this._vectorMutationFailed = true;
  }

  private async _ensureClean(): Promise<void> {
    if (this._vectorMutationFailed) await this.reconcile();
  }

  private async _runReconciliation(): Promise<void> {
    const release = await this._acquireReconcile();
    try {
      await this._phaseContext.run({ phase: "reconcile" }, () =>
        this._reconcileUnderPhase(),
      );
    } finally {
      release();
    }
  }

  private async _reconcileUnderPhase(): Promise<void> {
    try {
      await this._reconcileTask();
      this._vectorMutationFailed = false;
      this._reconciledEpoch = this._mutationEpoch;
    } catch (error) {
      this._vectorMutationFailed = true;
      throw error;
    }
  }

  private _assertNoConflictingReentry(requestedPhase: Phase): void {
    const currentPhase = this._phaseContext.getStore()?.phase;
    if (!currentPhase || (currentPhase === "read" && requestedPhase === "read")) {
      return;
    }

    const reason =
      currentPhase === "read" && requestedPhase === "mutation"
        ? "stable_read_reentrancy"
        : "phase_reentrancy";
    throw new MemoriaError(
      "concurrency",
      `Cannot start ${requestedPhase} phase from an active ${currentPhase} phase.`,
      {
        details: {
          reason,
          currentPhase,
          requestedPhase,
        },
      },
    );
  }

  private async _acquireRead(): Promise<() => void> {
    this._pendingReaders += 1;
    try {
      for (;;) {
        const canEnter =
          this._queuedMutations === 0 &&
          this._pendingReconciles === 0 &&
          (this._phase === "idle" || this._phase === "read");
        if (canEnter) {
          this._pendingReaders -= 1;
          this._phase = "read";
          this._activeReaders += 1;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            this._activeReaders -= 1;
            if (this._activeReaders === 0) this._phase = "idle";
            this._notifyPhaseChange();
          };
        }
        await this._waitForPhaseChange();
      }
    } catch (error) {
      this._pendingReaders -= 1;
      this._notifyPhaseChange();
      throw error;
    }
  }

  private async _acquireMutation(): Promise<() => void> {
    try {
      for (;;) {
        const canEnter =
          this._pendingReconciles === 0 &&
          this._activeReaders === 0 &&
          (this._phase === "idle" || this._phase === "mutation");
        if (canEnter) {
          this._queuedMutations -= 1;
          this._phase = "mutation";
          this._activeMutations += 1;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            this._activeMutations -= 1;
            if (this._activeMutations === 0) this._phase = "idle";
            this._notifyPhaseChange();
          };
        }
        await this._waitForPhaseChange();
      }
    } catch (error) {
      this._notifyPhaseChange();
      throw error;
    }
  }

  private async _acquireReconcile(): Promise<() => void> {
    this._pendingReconciles += 1;
    try {
      for (;;) {
        if (
          this._phase === "idle" &&
          this._activeReaders === 0 &&
          this._activeMutations === 0
        ) {
          this._pendingReconciles -= 1;
          this._phase = "reconcile";
          let released = false;
          return () => {
            if (released) return;
            released = true;
            this._phase = "idle";
            this._notifyPhaseChange();
          };
        }
        await this._waitForPhaseChange();
      }
    } catch (error) {
      this._pendingReconciles -= 1;
      this._notifyPhaseChange();
      throw error;
    }
  }

  private _waitForPhaseChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      this._phaseWaiters.push(resolve);
    });
  }

  private _notifyPhaseChange(): void {
    const waiters = this._phaseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

export default DerivedStateCoordinator;
