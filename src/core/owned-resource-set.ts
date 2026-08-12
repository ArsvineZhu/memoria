type MaybePromise<T> = T | Promise<T>;

export interface OwnedResource<T> {
  get(): T | undefined;
  clear(): void;
  isOwned(): boolean;
  release(): void;
  beforeClose?(resource: T): MaybePromise<void>;
  close?(resource: T): MaybePromise<void>;
}

/**
 * Owns the cleanup policy for lazily-created runtime resources.
 *
 * A failed close deliberately leaves the resource and ownership flag intact,
 * so a later disposal attempt can retry it. Other resources are still
 * disposed after the first failure and the first error is rethrown.
 */
class OwnedResourceSet {
  private readonly resources: Array<OwnedResource<unknown>> = [];

  add<T>(resource: OwnedResource<T>): void {
    this.resources.push(resource as OwnedResource<unknown>);
  }

  async dispose(): Promise<void> {
    let firstError: unknown = null;

    for (const resource of this.resources) {
      if (!resource.isOwned()) continue;

      const value = resource.get();
      if (value === undefined) {
        resource.release();
        resource.clear();
        continue;
      }

      try {
        await resource.beforeClose?.(value);
        await resource.close?.(value);
        resource.release();
        resource.clear();
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError) throw firstError;
  }
}

export default OwnedResourceSet;
