import { describe, expect, it } from "vitest";

import { disposeHostControllerQueue, hostControllerQueue, SingleControllerQueue } from "../../src/core/controller-queue.js";

describe("SingleControllerQueue", () => {
  it("grants one controller at a time in FIFO order", async () => {
    const queue = new SingleControllerQueue({ leaseTtlMs: 1_000 });
    const first = await queue.acquire("run_one", "thread_one", new AbortController().signal);
    let granted = false;
    const secondPromise = queue.acquire("run_two", "thread_two", new AbortController().signal).then((lease) => { granted = true; return lease; });
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(queue.snapshot().queued.map((entry) => entry.runId)).toEqual(["run_two"]);
    first.release();
    const second = await secondPromise;
    expect(second.runId).toBe("run_two");
    second.release();
  });

  it("removes a cancelled queued request", async () => {
    const queue = new SingleControllerQueue();
    const first = await queue.acquire("run_one", "thread_one", new AbortController().signal);
    const controller = new AbortController();
    const queued = queue.acquire("run_two", "thread_two", controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    expect(queue.snapshot().queued).toHaveLength(0);
    first.release();
  });

  it("expires a stale lease and dispatches the next run without polling", async () => {
    const queue = new SingleControllerQueue({ leaseTtlMs: 15 });
    await queue.acquire("run_one", "thread_one", new AbortController().signal);
    const second = await queue.acquire("run_two", "thread_two", new AbortController().signal);
    expect(second.runId).toBe("run_two");
    second.release();
  });

  it("returns one host-wide queue per host", () => {
    expect(hostControllerQueue("host_shared")).toBe(hostControllerQueue("host_shared"));
    disposeHostControllerQueue("host_shared");
  });
});
