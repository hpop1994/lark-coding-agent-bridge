import { SessionHookError } from '../session/hook';
import type { RunPreparation } from '../session/lifecycle';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
}

export interface SubmitRunInput {
  scopeId: string;
  preparation?: RunPreparation;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  waitForCompletion(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const controller = new AbortController();
    const releaseScope = this.activeRuns.reserve(input.scopeId, controller);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      scopeId: input.scopeId,
      signal: controller.signal,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      controller.signal.throwIfAborted();
      if (input.preparation) Object.assign(runOptions, await input.preparation.prepare(controller.signal));
      runOptions.prompt = input.policy.prompt;
      controller.signal.throwIfAborted();
      await this.agent.prepareRun?.(runOptions);
      controller.signal.throwIfAborted();
    } catch (err) {
      let cleanupFailure: unknown;
      try { await input.preparation?.cancel?.(); } catch (cleanupError) { cleanupFailure = cleanupError; log.fail('session', cleanupError, { step: 'prepare-cleanup' }); }
      release();
      releaseScope();
      if (cleanupFailure) throw new RunRejected('session-hook-failed', `新会话准备失败：${String(err)}\n结束 hook 同时失败，记录已保留：${String(cleanupFailure)}`);
      if (err instanceof SessionHookError) throw new RunRejected('session-hook-failed', err.message);
      if (err instanceof RunRejected || err instanceof SpawnFailed) throw err;
      if (controller.signal.aborted) throw new RunRejected('run-cancelled', '新会话准备已取消，本轮对话未启动。');
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      await input.preparation?.cancel?.();
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      await input.preparation?.cancel?.();
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleaning: Promise<void> | undefined;
    const cleanup = (waitForExit: boolean): Promise<void> => cleaning ??= (async () => {
      try {
        if (waitForExit) {
          const exited = await run.waitForExit(this.postDoneExitGraceMs);
          if (!exited) {
            log.warn('run', 'post-done-exit-timeout', {
              ...dimensions,
              graceMs: this.postDoneExitGraceMs,
            });
            await run.stop().catch((err) => {
              log.warn('run', 'post-done-stop-failed', {
                ...dimensions,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
        const failures: unknown[] = [];
        try { await run.reap?.(); } catch (error) { failures.push(error); }
        try { await input.preparation?.finish(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'run cleanup and session persistence failed');
      } finally {
        this.activeRuns.unregister(input.scopeId, run);
        releaseScope();
        release();
      }
    })();
    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        for await (const event of run.events) {
          input.preparation?.onEvent(event);
          yield event;
        }
      },
    };
    const fanout = new EventFanout(observeRunEvents(events, {
      dimensions,
      startedAt,
      now: this.now,
    }), async () => {
      await cleanup(!handle.interrupted);
    });
    handle.waitForCompletion = () => fanout.waitForCompletion();

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      waitForCompletion: () => fanout.waitForCompletion(),
      stop: async () => {
        handle.interrupted = true;
        try {
          await run.stop();
          await run.waitForExit(this.postDoneExitGraceMs);
        } finally { await cleanup(false); }
      },
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private pumping?: Promise<void>;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private start(): void {
    this.pumping ??= this.pump();
  }

  async waitForCompletion(): Promise<void> {
    this.start();
    await this.pumping;
    if (this.error) throw this.error;
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      try { await this.onDone(); }
      catch (error) { this.error = error; log.fail('run', error, { step: 'cleanup' }); }
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
