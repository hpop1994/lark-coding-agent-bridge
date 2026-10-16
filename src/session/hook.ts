import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { realpath, stat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnProcess } from '../platform/spawn';
import type { SessionHookCommand } from '../config/session-lifecycle';
import { log } from '../core/logger';

export class SessionHookError extends Error {}
export interface HookContext {
  scopeId: string; agentId: string; sessionId?: string; profile?: string; workspace?: string;
  event?: 'beforeSessionStart' | 'afterSessionEnd'; reason?: string; state?: unknown;
}
export interface HookResult { cwd?: string; state?: unknown }

/** A hook owns its process group, including Git/SSH grandchildren. */
export async function runSessionHook(
  hook: SessionHookCommand,
  workspace: string,
  signal: AbortSignal,
  context: HookContext,
): Promise<HookResult> {
  signal.throwIfAborted();
  let cwd: string;
  try {
    cwd = await realpath(hook.cwd ?? workspace);
    if (!(await stat(cwd)).isDirectory()) throw new Error('不是目录');
  } catch (err) {
    throw new SessionHookError(`新会话 hook 工作目录无效：${hook.cwd ?? workspace}\n${String(err)}`);
  }
  const resultDir = await mkdtemp(join(tmpdir(), 'lark-hook-'));
  const resultFile = join(resultDir, 'result.json');
  const startedAt = Date.now();
  const fields = { scopeId: context.scopeId, agentId: context.agentId, sessionId: context.sessionId,
    profile: context.profile, event: context.event, reason: context.reason, cwd };
  log.info('hook', 'started', fields);
  try {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let failure: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawnProcess(hook.command, hook.args, {
      cwd, shell: false, detached: process.platform !== 'win32',
      env: { ...process.env, LARK_HOOK_SCOPE: context.scopeId, LARK_HOOK_AGENT: context.agentId,
        LARK_HOOK_WORKSPACE: context.workspace ?? workspace, LARK_HOOK_RESULT_FILE: resultFile,
        LARK_HOOK_SESSION_ID: context.sessionId, LARK_HOOK_EVENT: context.event },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kill = (force: boolean): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          spawnProcess('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], { stdio: 'ignore' });
        } else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') log.warn('hook', 'kill-failed', { error: String(err) });
      }
    };
    const terminate = (reason: string): void => {
      if (failure) return;
      failure = reason;
      kill(false);
      killTimer = setTimeout(() => kill(true), 1000);
    };
    const abort = (): void => terminate('已取消');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => terminate(`超过 ${hook.timeoutMs}ms，已终止`), hook.timeoutMs);
    const append = (stream: string) => (data: Buffer): void => {
      const chunk = data.toString('utf8');
      output = (output + chunk).slice(-6000);
      log.info('hook', 'output', { ...fields, stream, chunk: chunk.slice(-16000) });
    };
    child.stdout?.on('data', append('stdout'));
    child.stderr?.on('data', append('stderr'));
    child.stdin?.on('error', (err) => { if ((err as NodeJS.ErrnoException).code !== 'EPIPE') terminate(String(err)); });
    child.stdin?.end(JSON.stringify({ ...context, workspace: context.workspace ?? workspace }));
    child.once('error', (err) => { failure = `无法启动：${err.message}`; });
    child.once('close', (code, childSignal) => {
      clearTimeout(timer);
      // Kill surviving grandchildren even if the shell exits first.
      if (failure) kill(true);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      const reason = failure ?? (code === 0 ? undefined : `退出码 ${code ?? childSignal}`);
      log.info('hook', reason ? 'failed' : 'completed', { ...fields, code, durationMs: Date.now() - startedAt, output });
      if (reason) reject(new SessionHookError(`会话 hook 失败，已阻断本轮对话（${reason}）。\n${output || '脚本无输出。'}`));
      else resolve();
    });
  });
  let raw: unknown;
  try {
    if ((await stat(resultFile)).size > 65536) throw new Error('hook result 超过 64KiB');
    raw = JSON.parse(await readFile(resultFile, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new SessionHookError(`Hook 结果无效：${String(err)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SessionHookError('hook result 必须为 JSON 对象');
  const result = raw as HookResult;
  if (result.cwd !== undefined && (typeof result.cwd !== 'string' || !isAbsolute(result.cwd))) {
    throw new SessionHookError('hook result.cwd 必须为绝对路径');
  }
  return result;
  } finally { await rm(resultDir, { recursive: true, force: true }); }
}
