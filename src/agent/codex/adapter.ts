import { join } from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { mergeProcessEnv } from '../../platform/spawn';
import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
import type { AgentAdapter, AgentBotIdentity, AgentRun, AgentRunOptions, AgentSteerInput } from '../types';
import type { SandboxMode } from '../../config/profile-schema';
import { CodexRpc, RpcError, object, string, type ObjectValue } from './rpc';
import { EventQueue, ServerEvents } from './server-events';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  sandbox?: SandboxMode;
  larkChannel?: LarkChannelEnvContext;
  rpcTimeoutMs?: number;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';
  private identity?: AgentBotIdentity;
  private sessions = new Map<string, { cwd: string; server: Promise<ServerSession> }>();
  constructor(private readonly options: CodexAdapterOptions) {}
  setBotIdentity(identity: AgentBotIdentity): void { this.identity = identity; }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({ agentId: 'codex', agentName: 'Codex CLI', command: this.options.binary, binaryPath: this.options.binary });
  }
  async prepareRun(opts?: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) throw new SpawnFailed('codex binary check failed', availability.error, availability.diagnostic.code, availability.diagnostic);
    if (opts) await this.session(opts);
  }
  run(opts: AgentRunOptions): AgentRun {
    const run = new ServerRun(opts, async (server) => {
      if (opts.sessionKey) return;
      const key = opts.scopeId ?? opts.cwd!;
      const entry = this.sessions.get(key);
      await server.close();
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
    });
    run.start(this.session(opts));
    return run;
  }
  async endSession(cwd: string): Promise<void> {
    for (const [key, entry] of this.sessions) {
      if (entry.cwd !== cwd) continue;
      await (await entry.server).close();
      this.sessions.delete(key);
    }
  }
  async dispose(): Promise<void> {
    const entries = [...this.sessions.entries()];
    const results = await Promise.allSettled(entries.map(async ([key, entry]) => {
      await (await entry.server).close();
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
    }));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  private session(opts: AgentRunOptions): Promise<ServerSession> {
    if (!opts.cwd) return Promise.reject(new Error('cwd is required for CodexAdapter.run'));
    const key = opts.sessionKey ?? opts.scopeId ?? opts.cwd;
    const existing = this.sessions.get(key);
    if (existing && existing.cwd !== opts.cwd) return Promise.reject(new Error('session cwd changed without ending the previous server'));
    if (existing) return existing.server.then(async (server) => {
      if (server.rpc.alive) return server;
      await server.close();
      if (this.sessions.get(key) === existing) this.sessions.delete(key);
      return this.session(opts);
    });
    const env = buildLarkChannelEnv(this.options.larkChannel);
    if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
    else if (this.options.inheritCodexHome === false) env.CODEX_HOME = join(this.options.profileStateDir, 'codex-home');
    const rpc = new CodexRpc(this.options.binary, opts.cwd, mergeProcessEnv(process.env, env), this.options.rpcTimeoutMs);
    const server = new ServerSession(rpc, opts.cwd);
    const abort = (): void => { void server.close().catch((error) => log.fail('agent', error, { step: 'abort-server-preparation' })); };
    opts.signal?.addEventListener('abort', abort, { once: true });
    const ready = server.initialize(opts, this.options.sandbox ?? 'danger-full-access', buildBridgeSystemPrompt(this.identity))
      .then(() => server)
      .catch(async (error: unknown) => {
        this.sessions.delete(key);
        await server.close();
        throw error;
      }).finally(() => opts.signal?.removeEventListener('abort', abort));
    this.sessions.set(key, { cwd: opts.cwd, server: ready });
    return ready;
  }
}

function inputItems(prompt: string, images?: readonly string[]): ObjectValue[] {
  return [{ type: 'text', text: prompt }, ...(images ?? []).map((path) => ({ type: 'localImage', path }))];
}

class ServerSession {
  threadId!: string;
  model!: string;
  private active?: ServerRun;
  constructor(readonly rpc: CodexRpc, readonly cwd: string) {
    rpc.onNotification = (method, params) => {
      if (params.threadId !== this.threadId) return;
      if (method === 'error') log.warn('agent', 'server-error', { threadId: this.threadId, turnId: params.turnId, error: params.error, willRetry: params.willRetry });
      if (method === 'turn/completed') log.info('agent', 'server-turn-ended', { threadId: this.threadId, turnId: object(params.turn).id, status: object(params.turn).status });
      this.active?.notification(method, params);
    };
    rpc.onFailure = (error) => this.active?.fail(error);
    rpc.onRequest = (method) => {
      const active = this.active;
      if (!active) return;
      active.queue.push({ type: 'error', message: `Codex requested interactive input (${method}); this Bridge supports text follow-ups via steer. The turn was stopped.`, terminationReason: 'failed' });
      void active.stop().catch(async (error) => {
        log.fail('agent', error, { step: 'unsupported-server-request' });
        await this.close();
      });
    };
  }
  async initialize(opts: AgentRunOptions, sandbox: SandboxMode, instructions: string): Promise<void> {
    await this.rpc.request('initialize', { clientInfo: { name: 'lark_channel_bridge', title: 'Lark Channel Bridge', version: '0.7.1-qa.3' }, capabilities: { experimentalApi: true } });
    this.rpc.notify('initialized');
    const response = await this.rpc.request(opts.threadId ? 'thread/resume' : 'thread/start', {
      ...(opts.threadId ? { threadId: opts.threadId } : {}), cwd: this.cwd,
      ...(opts.model ? { model: opts.model } : {}), approvalPolicy: 'never', sandbox: opts.sandbox ?? sandbox,
      developerInstructions: instructions,
    });
    this.threadId = string(object(response.thread).id);
    this.model = string(response.model);
    try {
      await access(join(this.cwd, 'AGENTS.md'));
      const expected = await realpath(join(this.cwd, 'AGENTS.md'));
      const sources = response.instructionSources;
      if (!Array.isArray(sources) || !sources.includes(expected)) throw new Error('app-server did not load the session AGENTS.md');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    log.info('agent', 'server-ready', { pid: this.rpc.child.pid, threadId: this.threadId, cwd: this.cwd, model: this.model });
  }
  async begin(run: ServerRun): Promise<void> {
    if (!this.rpc.alive) throw new Error('session app-server is unavailable; begin a new session');
    if (this.active) throw new Error('previous turn has not completed cleanup');
    this.active = run;
    run.session = this;
    run.queue.push({ type: 'system', threadId: this.threadId, cwd: this.cwd, model: run.options.model ?? this.model });
    const response = await this.rpc.request('turn/start', {
      threadId: this.threadId, input: inputItems(run.options.prompt, run.options.images),
      ...(run.options.model ? { model: run.options.model } : {}),
      approvalPolicy: 'never',
    });
    run.setTurnId(string(object(response.turn).id));
  }
  async finish(run: ServerRun): Promise<void> {
    await run.steers;
    if (this.active !== run) return;
    try {
      if (!this.rpc.alive) await this.close();
      else await this.rpc.request('thread/backgroundTerminals/clean', { threadId: this.threadId });
    } catch (error) {
      await this.close();
      throw error;
    } finally { this.active = undefined; }
  }
  close(): Promise<void> { return this.rpc.close(); }
}

class ServerRun implements AgentRun {
  readonly runId: string;
  readonly queue = new EventQueue();
  readonly events = this.queue;
  readonly translator = new ServerEvents(this.queue);
  session?: ServerSession;
  private turnId?: string;
  private terminal = false;
  private stopping?: Promise<void>;
  private finish?: Promise<void>;
  private resolveDone!: () => void;
  private done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  private started!: Promise<void>;
  steers: Promise<unknown> = Promise.resolve();
  constructor(readonly options: AgentRunOptions, private readonly releaseSession: (server: ServerSession) => Promise<void>) { this.runId = options.runId; }
  start(server: Promise<ServerSession>): void {
    this.started = server.then((session) => session.begin(this)).catch(async (error: unknown) => {
      if (this.session) await this.session.close();
      this.fail(error);
    });
  }
  setTurnId(id: string): void {
    if (this.turnId && this.turnId !== id) throw new Error('app-server turn identity changed');
    this.turnId = id;
  }
  notification(method: string, params: ObjectValue): void {
    if (this.terminal) return;
    if (method === 'turn/started') this.setTurnId(string(object(params.turn).id));
    if (params.turnId && this.turnId && params.turnId !== this.turnId) return;
    if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (this.turnId && turn.id !== this.turnId) return;
      this.translator.finish(this.session!.threadId, turn);
      this.terminal = true;
      this.resolveDone();
    } else this.translator.notification(method, params);
  }
  fail(error: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.queue.push({ type: 'error', message: error instanceof Error ? error.message : String(error), terminationReason: 'failed' });
    this.queue.end(); this.resolveDone();
  }
  async steer(input: AgentSteerInput): Promise<boolean> {
    const delivery = this.steers.then(async () => {
      await this.started;
      if (this.terminal || !this.session || !this.turnId) return false;
      try {
        const response = await this.session.rpc.request('turn/steer', {
          threadId: this.session.threadId, expectedTurnId: this.turnId,
          input: inputItems(input.prompt, input.images), clientUserMessageId: input.messageId,
        });
        if (response.turnId !== this.turnId) throw new Error('steer acknowledged a different turn');
        log.info('agent', 'steer-accepted', { runId: this.runId, turnId: this.turnId, messageId: input.messageId });
        return true;
      } catch (error) {
        if (error instanceof RpcError && /no active turn|expected.*turn|turn.*mismatch/i.test(error.message)) return false;
        throw error;
      }
    });
    this.steers = delivery.catch(() => {});
    return delivery;
  }
  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      await this.started;
      const session = this.session;
      if (!session) return;
      if (!this.terminal && this.turnId) {
        try { await session.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: this.turnId }); }
        catch (error) { await session.close(); this.fail(error); throw error; }
        if (!(await this.waitForExit(this.options.stopGraceMs ?? 5000))) {
          await session.close();
          this.fail(new Error('Codex did not complete interruption; session server was closed'));
        }
      }
    })();
  }
  async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([this.done.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  reap(): Promise<void> {
    return this.finish ??= (async () => {
      await this.started; await this.done;
      if (this.session) {
        try { await this.session.finish(this); }
        finally { await this.releaseSession(this.session); }
      }
    })();
  }
}
