import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly steering = new Map<string, (batch: NormalizedMessage[]) => Promise<boolean>>();
  private readonly steeringBusy = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;

  constructor(delayMs: number, onFlush: FlushHandler) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  push(scope: string, msg: NormalizedMessage): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.canFlush(scope) ? this.armTimer(scope) : undefined;
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [msg],
      timer: this.canFlush(scope) ? this.armTimer(scope) : undefined,
    });
    return 1;
  }

  has(scope: string): boolean { return this.map.has(scope) || this.blocked.has(scope); }

  cancel(scope: string): NormalizedMessage[] {
    this.epochs.set(scope, (this.epochs.get(scope) ?? 0) + 1);
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }

  cancelAll(): void {
    for (const scope of this.steeringBusy) this.epochs.set(scope, (this.epochs.get(scope) ?? 0) + 1);
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
    this.steering.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    this.steering.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0 || !this.canFlush(scope)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    if (!this.canFlush(scope)) { entry.timer = undefined; return; }
    this.map.delete(scope);
    const steer = this.steering.get(scope);
    if (this.blocked.has(scope) && steer) {
      this.steeringBusy.add(scope);
      const epoch = this.epochs.get(scope) ?? 0;
      void steer(entry.messages).then((accepted) => {
        if (!accepted && epoch === (this.epochs.get(scope) ?? 0)) {
          const queued = this.map.get(scope);
          if (queued?.timer) clearTimeout(queued.timer);
          this.map.set(scope, { messages: [...entry.messages, ...(queued?.messages ?? [])] });
          this.steering.delete(scope);
        }
      }).catch((error) => log.fail('queue', error, { scope, step: 'steer-handler' }))
        .finally(() => {
          this.steeringBusy.delete(scope);
          const queued = this.map.get(scope);
          if (queued && this.canFlush(scope)) queued.timer = this.armTimer(scope);
        });
      return;
    }
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }

  setSteering(scope: string, handler: (batch: NormalizedMessage[]) => Promise<boolean>): void {
    this.steering.set(scope, handler);
    const entry = this.map.get(scope);
    if (entry && !entry.timer && this.canFlush(scope)) entry.timer = this.armTimer(scope);
  }

  private canFlush(scope: string): boolean {
    return !this.steeringBusy.has(scope) && (!this.blocked.has(scope) || this.steering.has(scope));
  }
}
