import { isAbsolute } from 'node:path';

export interface SessionHookCommand {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}

export interface SessionHooks {
  beforeSessionStart?: SessionHookCommand;
  afterSessionEnd?: SessionHookCommand;
}

export function sessionAutoResetMinutes(value: unknown = 15): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 525600) {
    throw new Error('会话自动重置分钟数必须为 0 到 525600 的整数（0=关闭）');
  }
  return value;
}

export function parseSessionHooks(input: unknown): SessionHooks {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('hooks 必须为对象');
  const hooks = input as Record<string, unknown>;
  if (Object.keys(hooks).some((key) => key !== 'beforeSessionStart' && key !== 'afterSessionEnd')) throw new Error('不支持的 hook 事件');
  const result: SessionHooks = {};
  for (const event of ['beforeSessionStart', 'afterSessionEnd'] as const) {
    if (hooks[event] !== undefined) result[event] = parseHook(hooks[event]);
  }
  return result;
}

function parseHook(raw: unknown): SessionHookCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hook 必须为对象');
  const hook = raw as Record<string, unknown>;
  if (typeof hook.command !== 'string' || !hook.command.trim()) throw new Error('hook command 不能为空');
  if (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error('hook args 必须为字符串数组');
  }
  if (hook.cwd !== undefined && (typeof hook.cwd !== 'string' || !isAbsolute(hook.cwd))) {
    throw new Error('hook cwd 必须为绝对路径');
  }
  const timeoutMs = hook.timeoutMs ?? 120000;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) {
    throw new Error('hook timeoutMs 必须为 1 到 3600000 的整数');
  }
  return {
    command: hook.command,
    args: (hook.args ?? []) as string[],
    ...(hook.cwd ? { cwd: hook.cwd as string } : {}),
    timeoutMs,
  };
}

export function validateSessionSettings(minutes: unknown, hooks: SessionHooks, concurrency: number): void {
  sessionAutoResetMinutes(minutes);
  if ((hooks.beforeSessionStart || hooks.afterSessionEnd) && concurrency !== 1) {
    throw new Error('配置会话 Hook 时 maxConcurrentRuns 必须为 1，以防并发修改共享工作区');
  }
}
