type AsyncTask<T> = () => T | Promise<T>;

/**
 * Coordinates concurrent authority mutations with reads and derived-index
 * reconciliation. Mutations for different keys may overlap; a stable read or
 * reconciliation is a barrier that admits no new mutation until all admitted
 * mutations have finished.
 */
class DerivedStateCoordinator {
  private readonly _reconcileTask: AsyncTask<void>;
  private readonly _mutationTails = new Map<string, Promise<void>>();
  private _barrierTail: Promise<void> = Promise.resolve();
  private _barrierPending = 0;
  private _barrierActive = false;
  private _activeMutations = 0;
  private _mutationEpoch = 0;
  private _reconciledEpoch = 0;
  private _vectorMutationFailed = false;
  private _noMutationWaiters: Array<() => void> = [];

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
    const normalizedKey = key || "__default__";
    const previous = this._mutationTails.get(normalizedKey) ?? Promise.resolve();
    const run = previous.then(async () => {
      await this._waitForMutationAdmission();
      if (this._vectorMutationFailed) {
        await this.reconcile();
      }
      await this._waitForMutationAdmission();

      this._activeMutations += 1;
      const epoch = ++this._mutationEpoch;
      try {
        return await task(epoch);
      } catch (error) {
        this._vectorMutationFailed = true;
        throw error;
      } finally {
        this._activeMutations -= 1;
        this._notifyNoMutationWaiters();
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
  runStableRead<T>(task: AsyncTask<T>): Promise<T> {
    return this._runBarrier(async () => {
      if (this._vectorMutationFailed) {
        await this._reconcileUnderBarrier();
      }
      return task();
    });
  }

  /** Force a full reconciliation, even when the coordinator is currently clean. */
  reconcile(): Promise<void> {
    return this._runBarrier(() => this._reconcileUnderBarrier());
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

  private async _reconcileUnderBarrier(): Promise<void> {
    try {
      await this._reconcileTask();
      this._vectorMutationFailed = false;
      this._reconciledEpoch = this._mutationEpoch;
    } catch (error) {
      this._vectorMutationFailed = true;
      throw error;
    }
  }

  private async _runBarrier<T>(task: AsyncTask<T>): Promise<T> {
    this._barrierPending += 1;
    const previous = this._barrierTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._barrierTail = previous.then(() => current);

    await previous;
    this._barrierActive = true;
    try {
      await this._waitForNoMutations();
      return await task();
    } finally {
      this._barrierActive = false;
      this._barrierPending -= 1;
      release();
    }
  }

  private async _waitForMutationAdmission(): Promise<void> {
    while (this._barrierPending > 0 || this._barrierActive) {
      await this._barrierTail;
    }
  }

  private _waitForNoMutations(): Promise<void> {
    if (this._activeMutations === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this._noMutationWaiters.push(resolve);
    });
  }

  private _notifyNoMutationWaiters(): void {
    if (this._activeMutations !== 0) return;
    const waiters = this._noMutationWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

export default DerivedStateCoordinator;
