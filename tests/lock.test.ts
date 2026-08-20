import { describe, expect, it } from "vitest";
import { BusyError, OperationLock } from "../src/core/lock";

describe("operation lock (invariant 2)", () => {
  it("refuses a second operation with a notice naming the first", async () => {
    const lock = new OperationLock();
    let release = () => {};
    const held = lock.run("compile", () => new Promise<void>((r) => (release = r)));

    expect(lock.busyWith).toBe("compile");
    await expect(lock.run("ask", async () => "never")).rejects.toThrow("Luka is busy: compile");
    await expect(lock.run("ask", async () => "never")).rejects.toBeInstanceOf(BusyError);

    release();
    await held;
    expect(lock.busyWith).toBe(null);
  });

  it("releases after a failure so the next invocation can proceed", async () => {
    const lock = new OperationLock();
    await expect(
      lock.run("compile", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.busyWith).toBe(null);
    await expect(lock.run("ask", async () => "ok")).resolves.toBe("ok");
  });
});
