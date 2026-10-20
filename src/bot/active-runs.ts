import type { AgentRun } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  waitForCompletion?(): Promise<void>;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Set<string>();
  private readonly preparationDone = new Map<AbortController, { promise: Promise<void>; resolve(): void }>();
  private readonly preparing = new Map<string, AbortController>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string, controller?: AbortController): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    this.reservations.add(chatId);
    if (controller) {
      this.preparing.set(chatId, controller);
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      this.preparationDone.set(controller, { promise, resolve });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations.delete(chatId);
      if (this.preparing.get(chatId) === controller) this.preparing.delete(chatId);
      if (controller) { this.preparationDone.get(controller)?.resolve(); this.preparationDone.delete(controller); }
    };
  }

  register(chatId: string, run: AgentRun): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const controller = this.preparing.get(chatId);
    if (controller) { this.preparationDone.get(controller)?.resolve(); this.preparationDone.delete(controller); }
    this.preparing.delete(chatId);
    const handle: RunHandle = { run, interrupted: false };
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...new Set([...this.handles.keys(), ...this.preparing.keys()])];
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) {
      const preparing = this.preparing.get(chatId);
      if (!preparing) return false;
      preparing.abort();
      return true;
    }
    h.interrupted = true;
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    const pending = [...this.preparationDone.values()].map((entry) => entry.promise);
    for (const controller of this.preparing.values()) controller.abort();
    this.handles.clear();
    this.reservations.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map(async (h) => {
      try { await h.run.stop(); }
      finally { await h.waitForCompletion?.(); }
    }));
    await Promise.all(pending);
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}
