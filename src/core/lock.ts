// invariant 2: one global operation lock; compile and ask are
// mutually exclusive and a second invocation is refused, never queued.
import type { OperationName } from "./types";

export class BusyError extends Error {
  constructor(readonly operation: OperationName) {
    super(`Luka is busy: ${operation}`);
    this.name = "BusyError";
  }
}

export class OperationLock {
  private held: OperationName | null = null;

  get busyWith(): OperationName | null {
    return this.held;
  }

  /** Throws `BusyError` naming the running operation rather than waiting. */
  async run<T>(operation: OperationName, fn: () => Promise<T>): Promise<T> {
    if (this.held !== null) throw new BusyError(this.held);
    this.held = operation;
    try {
      return await fn();
    } finally {
      this.held = null;
    }
  }
}
