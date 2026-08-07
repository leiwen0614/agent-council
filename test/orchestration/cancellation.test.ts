import { afterEach, describe, expect, it, vi } from "vitest";
import { CancellationManager } from "../../src/orchestration/cancellation.js";

describe("CancellationManager", () => {
  const managers: CancellationManager[] = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.uninstall();
  });

  it("treats the first interrupt of each installation as graceful", async () => {
    const manager = new CancellationManager();
    managers.push(manager);
    const onFirstInterrupt = vi.fn();
    const cancel = vi.fn(() => Promise.resolve());
    manager.add({ pid: undefined, cancel });

    manager.install(onFirstInterrupt);
    process.emit("SIGINT");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(false));
    manager.uninstall();

    cancel.mockClear();
    manager.install(onFirstInterrupt);
    process.emit("SIGINT");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(false));

    expect(onFirstInterrupt).toHaveBeenCalledTimes(2);
  });

  it("supports graceful then forced programmatic interrupts", async () => {
    const manager = new CancellationManager();
    managers.push(manager);
    const onFirstInterrupt = vi.fn();
    const cancel = vi.fn(() => Promise.resolve());
    manager.add({ pid: undefined, cancel });
    manager.install(onFirstInterrupt);

    manager.interrupt();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(false));
    manager.interrupt();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(true));

    expect(onFirstInterrupt).toHaveBeenCalledOnce();
  });

  it("shares the interrupt counter between signals and programmatic input", async () => {
    const manager = new CancellationManager();
    managers.push(manager);
    const cancel = vi.fn(() => Promise.resolve());
    manager.add({ pid: undefined, cancel });
    manager.install(() => undefined);

    process.emit("SIGINT");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(false));
    manager.interrupt();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(true));
  });
});
