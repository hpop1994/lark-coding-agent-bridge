import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import type { SessionHooks } from '../config/session-lifecycle';
import { runSessionHook, type HookContext } from './hook';
import { log } from '../core/logger';

export interface SessionResource {
  id: string;
  scopeId: string;
  agentId: string;
  profile: string;
  baseCwd: string;
  cwd: string;
  fingerprint: string;
  phase: 'preparing' | 'active' | 'ending' | 'ended';
  hooks: SessionHooks;
  state?: unknown;
  lastCompletedAt: number;
  chatId?: string;
  threadId?: string;
  endReason?: string;
  endFailed?: boolean;
}

/** Owns only session records. Project-specific resources are opaque to the bridge. */
export class SessionResources {
  beforeEnd?: (entry: SessionResource) => Promise<void>;
  private entries = new Map<string, SessionResource>();
  private saving = Promise.resolve();
  private busy = new Set<string>();
  private reasons = new Map<string, string>();
  private stopping = new AbortController();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(data)) throw new Error('session resources must be an array');
      for (const value of data) {
        const entry = value as SessionResource;
        if (!entry || typeof entry.id !== 'string' || typeof entry.scopeId !== 'string' ||
          typeof entry.cwd !== 'string' || typeof entry.lastCompletedAt !== 'number' ||
          !['preparing', 'active', 'ending', 'ended'].includes(entry.phase)) throw new Error('invalid session resource');
        this.entries.set(entry.scopeId, entry);
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  get(scopeId: string): SessionResource | undefined { return this.entries.get(scopeId); }
  requestEnd(scopeId: string, reason: string): void { this.reasons.set(scopeId, reason); }
  requestedReason(scopeId: string): string | undefined { return this.reasons.get(scopeId); }
  endRequested(scopeId: string): boolean { return this.reasons.has(scopeId); }
  claim(scopeId: string): (() => void) | undefined {
    if (this.busy.has(scopeId)) return undefined;
    this.busy.add(scopeId);
    return () => { this.busy.delete(scopeId); };
  }
  async create(input: Omit<SessionResource, 'id' | 'phase' | 'cwd' | 'lastCompletedAt'>, signal: AbortSignal): Promise<SessionResource> {
    const entry: SessionResource = { ...input, id: randomUUID(), cwd: input.baseCwd,
      phase: 'preparing', lastCompletedAt: Date.now() };
    this.entries.set(entry.scopeId, entry);
    await this.persist();
    const hook = entry.hooks.beforeSessionStart;
    if (hook) {
      const result = await runSessionHook(hook, entry.baseCwd, signal, this.context(entry, 'beforeSessionStart', 'new_session'));
      entry.cwd = result.cwd ?? entry.baseCwd;
      entry.state = result.state;
    }
    entry.phase = 'active';
    await this.persist();
    log.info('session', 'resource-ready', this.fields(entry));
    return entry;
  }
  async complete(scopeId: string, id: string, now: number): Promise<void> {
    const entry = this.entries.get(scopeId);
    if (entry?.id !== id || entry.phase !== 'active') return;
    entry.lastCompletedAt = now;
    await this.persist();
  }
  async end(scopeId: string, reason: string, signal: AbortSignal = this.stopping.signal): Promise<void> {
    const entry = this.entries.get(scopeId);
    if (!entry || entry.phase === 'ended') { this.reasons.delete(scopeId); return; }
    entry.phase = 'ending'; entry.endReason = reason;
    await this.persist();
    log.info('session', 'ending', { ...this.fields(entry), reason });
    entry.endFailed = false;
    try {
    await this.beforeEnd?.(entry);
    if (entry.hooks.afterSessionEnd) {
      await runSessionHook(entry.hooks.afterSessionEnd, entry.baseCwd, signal,
        { ...this.context(entry, 'afterSessionEnd', reason), workspace: entry.cwd });
    }
    } catch (error) { entry.endFailed = !signal.aborted; await this.persist(); throw error; }
    entry.phase = 'ended'; this.reasons.delete(scopeId);
    await this.persist();
    log.info('session', 'ended', { ...this.fields(entry), reason });
  }
  /** Caller admits cleanup through the same scope/pool used for Agent execution. */
  async sweep(input: {
    minutes: number; now: number; isPending(scope: string): boolean;
    acquire(scope: string): (() => void) | undefined;
    onEnded(entry: SessionResource): Promise<void>;
    onError(entry: SessionResource, error: unknown): Promise<void>;
  }): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (this.stopping.signal.aborted || this.busy.has(entry.scopeId) || input.isPending(entry.scopeId)) continue;
      if (entry.phase === 'ended' || entry.endFailed) continue;
      const expired = input.minutes > 0 && input.now - entry.lastCompletedAt >= input.minutes * 60000;
      if (!expired && entry.phase === 'active' && !this.reasons.has(entry.scopeId)) continue;
      const release = input.acquire(entry.scopeId);
      if (!release) continue;
      const unclaim = this.claim(entry.scopeId);
      if (!unclaim) { release(); continue; }
      try {
        if (input.isPending(entry.scopeId)) continue;
        const reason = this.reasons.get(entry.scopeId) ?? entry.endReason ??
          (entry.phase === 'preparing' ? 'prepare_interrupted' : 'idle_timeout');
        await this.end(entry.scopeId, reason);
        await input.onEnded(entry);
      } catch (error) {
        log.fail('session', error, { ...this.fields(entry), step: 'end-hook' });
        if (!this.stopping.signal.aborted) await input.onError(entry, error);
      } finally { unclaim(); release(); }
    }
  }
  start(): void { if (this.stopping.signal.aborted) this.stopping = new AbortController(); }
  stop(): void { this.stopping.abort(); }
  async flush(): Promise<void> { await this.saving; }
  private context(entry: SessionResource, event: HookContext['event'], reason: string): HookContext {
    return { sessionId: entry.id, scopeId: entry.scopeId, agentId: entry.agentId,
      profile: entry.profile, event, reason, state: entry.state };
  }
  private fields(entry: SessionResource) {
    return { sessionId: entry.id, scopeId: entry.scopeId, profile: entry.profile, cwd: entry.cwd };
  }
  private persist(): Promise<void> {
    const payload = JSON.stringify([...this.entries.values()], null, 2) + '\n';
    const saving = this.saving.then(() => writeFileAtomic(this.path, payload, { mode: 0o600 }));
    this.saving = saving.catch((error) => { log.fail('session', error, { step: 'resource-persist' }); });
    return saving;
  }
}
