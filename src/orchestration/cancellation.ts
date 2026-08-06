import { execa } from "execa";

export type CancellableProcess = {
  readonly pid: number | undefined;
  cancel(force?: boolean): Promise<void>;
};

export async function terminateProcessTree(pid: number, force: boolean): Promise<void> {
  if (process.platform === "win32") {
    const argumentsList = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    await execa("taskkill", argumentsList, { reject: false, shell: false, windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // The process may have completed between the status check and signal.
    }
  }
}

export class CancellationManager {
  private readonly processes = new Set<CancellableProcess>();
  private interruptCount = 0;
  private onSignal: (() => void) | null = null;

  add(processHandle: CancellableProcess): () => void {
    this.processes.add(processHandle);
    return () => this.processes.delete(processHandle);
  }

  install(onFirstInterrupt: () => void): void {
    if (this.onSignal !== null) process.off("SIGINT", this.onSignal);
    this.interruptCount = 0;
    this.onSignal = () => {
      this.interruptCount += 1;
      if (this.interruptCount === 1) onFirstInterrupt();
      void this.cancelAll(this.interruptCount > 1);
    };
    process.on("SIGINT", this.onSignal);
  }

  uninstall(): void {
    if (this.onSignal !== null) process.off("SIGINT", this.onSignal);
    this.onSignal = null;
  }

  get cancelled(): boolean {
    return this.interruptCount > 0;
  }

  async cancelAll(force = false): Promise<void> {
    await Promise.allSettled([...this.processes].map((handle) => handle.cancel(force)));
  }
}
