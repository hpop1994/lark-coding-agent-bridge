import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { reapProcessGroup } from '../../platform/process-group';
import { log } from '../../core/logger';

export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid app-server object');
  return value as ObjectValue;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid app-server string');
  return value;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export class CodexRpc {
  readonly child: SpawnedProcessByStdio<Writable, Readable, Readable>;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: ObjectValue): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private failure?: Error;
  private closing?: Promise<void>;
  private stderr = '';
  onNotification: (method: string, params: ObjectValue) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  onRequest: (method: string, params: ObjectValue) => void = () => {};

  constructor(binary: string, cwd: string, env: NodeJS.ProcessEnv, readonly timeoutMs = 30_000) {
    this.child = spawnProcess(binary, ['app-server', '--stdio', '-c', 'approval_policy="never"',
      '-c', 'shell_environment_policy.inherit="all"'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    }) as typeof this.child;
    const reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      try { this.receive(object(JSON.parse(line))); }
      catch (error) { this.fail(new Error('invalid app-server protocol', { cause: error })); }
    });
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      reader.close();
      this.fail(new Error(`Codex app-server exited (${code ?? signal}): ${this.stderr.trim()}`));
    });
    log.info('agent', 'server-spawn', { pid: this.child.pid, cwd });
  }

  get alive(): boolean { return !this.failure && !this.closing; }

  request(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (!this.alive) return Promise.reject(this.failure ?? new Error('app-server is closing'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; delivery outcome is unknown and must not be replayed automatically`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string): void { this.send({ method }); }

  private send(message: ObjectValue): void {
    this.child.stdin.write(JSON.stringify(message) + '\n', (error) => { if (error) this.fail(error); });
  }

  private receive(message: ObjectValue): void {
    if (typeof message.method === 'string') {
      const params = object(message.params ?? {});
      if (message.id !== undefined) {
        this.send({ id: message.id, error: { code: -32601, message: 'Bridge does not provide interactive approval for this request' } });
        this.onRequest(message.method, params);
      } else this.onNotification(message.method, params);
      return;
    }
    if (typeof message.id !== 'number') throw new Error('app-server response missing request id');
    const request = this.pending.get(message.id);
    if (!request) return; // A timed-out request can still receive a late reply.
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      const error = object(message.error);
      request.reject(new RpcError(Number(error.code), string(error.message)));
    } else request.resolve(object(message.result));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.onFailure(error);
    if (!this.closing) void this.close().catch((cleanupError) => log.fail('agent', cleanupError, { step: 'failed-server-cleanup' }));
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await reapProcessGroup(this.child);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('app-server did not exit after process-group cleanup')), 5000);
          this.child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      this.fail(new Error('app-server closed'));
    })();
  }
}
