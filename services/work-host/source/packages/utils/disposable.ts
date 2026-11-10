/**
 * A resource with a lifetime.
 *
 * Stores, bridges and workers are held by whatever created them and released when that owner goes
 * away, without the owner knowing which kind it holds: extending this class is what makes a
 * resource releasable, and `instanceof` is how a holder finds out that it should be.
 */

export abstract class Disposable {
  /** Releases everything this resource holds. Safe to call once, from the owner's teardown. */
  abstract dispose(): void | Promise<void>
}
