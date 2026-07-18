import { afterEach, describe, expect, it, vi } from "vitest";

import { createStatusEventStream } from "./route";

describe("workspace status event stream", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for a request to settle before scheduling the next one", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { event: string; data: unknown }) => void;
    const load = vi.fn(() => new Promise<{ event: string; data: unknown }>((done) => { resolve = done; }));
    const reader = createStatusEventStream(load, 1000).getReader();

    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(1);
    resolve({ event: "status", data: { ok: true } });
    await reader.read();
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await reader.cancel();
  });

  it("does not enqueue or reschedule after cancellation while awaiting", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { event: string; data: unknown }) => void;
    const load = vi.fn(() => new Promise<{ event: string; data: unknown }>((done) => { resolve = done; }));
    const reader = createStatusEventStream(load, 100).getReader();
    await reader.cancel();
    resolve({ event: "status", data: {} });
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
