import { startRunFlow } from '../../../src/bot/run-flow';
import { codexCapability } from '../../../src/agent/capability';
import { WorkspaceStore } from '../../../src/workspace/store';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSessionHooks, sessionAutoResetMinutes } from '../../../src/config/session-lifecycle';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { sessionLifecycle } from '../../../src/session/lifecycle';
import { runSessionHook } from '../../../src/session/hook';
import { SessionResources } from '../../../src/session/resources';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'session-lifecycle-')); roots.push(path); return await realpath(path); }
const identity = { scopeId: 'group-a', agentId: 'codex' as const, cwdRealpath: '', policyFingerprint: 'policy' };
const signal = () => new AbortController().signal;
const hook = (code: string, cwd?: string, timeoutMs = 3000) => ({ command: process.execPath, args: ['-e', code], cwd, timeoutMs });

describe('session lifecycle contract', () => {
  it('reaps the session server before invoking the destructive end hook', async () => {
    const path = await root(); const resources = new SessionResources(join(path, 'resources.json'));
    const marker = join(path, 'released');
    await resources.create({ scopeId: 'a', agentId: 'codex', profile: 'qa', baseCwd: path, fingerprint: 'p',
      hooks: { afterSessionEnd: hook(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'released')`, path) } }, signal());
    let release!: () => void; const reaping = new Promise<void>((resolve) => { release = resolve; });
    resources.beforeEnd = async () => { await reaping; };
    const ending = resources.end('a', 'manual_reset');
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
    release(); await ending; expect(await readFile(marker, 'utf8')).toBe('released');
  });

  it('defaults to 15 minutes and rejects invalid configuration', () => {
    expect(sessionAutoResetMinutes()).toBe(15);
    expect(sessionAutoResetMinutes(0)).toBe(0);
    for (const value of [-1, 0.5, NaN, '15', null]) expect(() => sessionAutoResetMinutes(value)).toThrow();
    expect(() => parseSessionHooks({ beforeSessionStart: { command: 'git', cwd: 'relative' } })).toThrow();
    expect(() => parseSessionHooks({ unknown: {} })).toThrow();
  });
  it('uses hook cwd and separates logs from structured results', async () => {
    const path = await root();
    const result = await runSessionHook(hook(`const fs=require('fs'); console.log('a log'); fs.writeFileSync(process.env.LARK_HOOK_RESULT_FILE, JSON.stringify({cwd:process.cwd(),state:{opaque:42}}))`, path), path, signal(), identity);
    expect(result).toEqual({ cwd: path, state: { opaque: 42 } });
  });
  it('returns explicit output for a failed hook and enforces timeout', async () => {
    const path = await root();
    await expect(runSessionHook(hook("console.error('sync failed');process.exit(7)", path), path, signal(), identity)).rejects.toThrow('sync failed');
    await expect(runSessionHook(hook('setInterval(()=>{},100)', path, 30), path, signal(), identity)).rejects.toThrow('已终止');
    await expect(runSessionHook(hook('', join(path, 'missing')), path, signal(), identity)).rejects.toThrow('工作目录无效');
  });
  it.each(['claude', 'codex'] as const)('resets %s exactly at threshold; queued time is not idle', async (agentId) => {
    const path = await root();
    const catalog = new SessionCatalog(join(path, 'catalog.json')); await catalog.load();
    const sessions = new SessionStore(join(path, 'sessions.json'));
    const id = { ...identity, agentId, cwdRealpath: path };
    catalog.upsertActive({ ...id, now: 1000, ...(agentId === 'codex' ? { threadId: 'old' } : { sessionId: 'old' }) });
    catalog.complete(id, 'old', 1000);
    const profile = createDefaultProfileConfig({ agentKind: agentId, accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      ...(agentId === 'codex' ? { codex: { binaryPath: 'codex' } } : {}) });
    const queued = sessionLifecycle({ identity: id, profile, sessions, catalog, now: () => 9999999, requestedAt: 900999 });
    await queued.prepare(signal()); expect(queued.resumeFrom).toBe('old'); await queued.finish();
    catalog.complete(id, 'old', 1000);
    await catalog.resources.complete(id.scopeId, catalog.resources.get(id.scopeId)!.id, 1000);
    const onReset = vi.fn(async () => {});
    const expired = sessionLifecycle({ identity: id, profile, sessions, catalog, now: () => 901000, requestedAt: 901000, onReset });
    await expired.prepare(signal()); expect(expired.resumeFrom).toBeUndefined(); expect(onReset).toHaveBeenCalledWith(15); await expired.finish();
  });
  it('persists workspace and opaque state across restart, and disposes only ended sessions', async () => {
    const path = await root(); const working = join(path, 'snapshot'); await mkdir(working);
    const file = join(path, 'resources.json'); const resources = new SessionResources(file); await resources.load();
    const marker = join(path, 'released');
    const created = await resources.create({ scopeId: 'a', agentId: 'codex', profile: 'qa', baseCwd: path, fingerprint: 'p',
      hooks: { beforeSessionStart: hook(`require('fs').writeFileSync(process.env.LARK_HOOK_RESULT_FILE,JSON.stringify({cwd:${JSON.stringify(working)},state:{value:7}}))`),
        afterSessionEnd: hook(`let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(marker)},s))`) } }, signal());
    await resources.complete('a', created.id, 1000);
    const restored = new SessionResources(file); await restored.load(); expect(restored.get('a')?.cwd).toBe(working);
    const ended = vi.fn(async () => {}); const errors = vi.fn(async () => {});
    const sweep = { minutes: 15, now: 901000, isPending: () => true, acquire: () => () => {}, onEnded: ended, onError: errors };
    await restored.sweep(sweep); expect(restored.get('a')).toBeDefined();
    await restored.sweep({ ...sweep, isPending: () => false });
    const received = JSON.parse(await readFile(marker, 'utf8'));
    expect(received.state).toEqual({ value: 7 }); expect(received.workspace).toBe(working);
    expect(received.sessionId).toBe(created.id); expect(restored.get('a')?.phase).toBe('ended'); expect(errors).not.toHaveBeenCalled();
  });
  it('keeps failed disposal durable and reports it instead of silently succeeding', async () => {
    const path = await root(); const resources = new SessionResources(join(path, 'resources')); await resources.load();
    const entry = await resources.create({ scopeId: 'a', agentId: 'codex', profile: 'qa', baseCwd: path, fingerprint: 'p', hooks: { afterSessionEnd: hook("console.error('release failed');process.exit(9)") } }, signal());
    await resources.complete('a', entry.id, 0); const onError = vi.fn(async () => {});
    await resources.sweep({ minutes: 15, now: 900000, isPending: () => false, acquire: () => () => {}, onEnded: async () => {}, onError });
    expect(onError).toHaveBeenCalledOnce(); expect(resources.get('a')?.phase).toBe('ending');
    const restored = new SessionResources(join(path, 'resources')); await restored.load(); expect(restored.get('a')?.endFailed).toBe(true);
  });
  it('keeps two groups on independent workspaces and resumes the original thread', async () => {
    const path = await root();
    const catalog = new SessionCatalog(join(path, 'catalog')); await catalog.load();
    const sessions = new SessionStore(join(path, 'sessions'));
    const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' }, preferences: { maxConcurrentRuns: 1 } });
    profile.workspaces.default = path;
    profile.hooks = { beforeSessionStart: hook(`const fs=require('fs'),path=require('path'); let s=''; process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const c=JSON.parse(s),cwd=path.join(c.workspace,c.sessionId);fs.mkdirSync(cwd);fs.writeFileSync(process.env.LARK_HOOK_RESULT_FILE,JSON.stringify({cwd}))})`) };
    const done = { type: 'done' as const, terminationReason: 'normal' as const };
    const agent = new FakeAgentAdapter({ events: [[{type:'system',threadId:'thread-a'},done],[{type:'system',threadId:'thread-b'},done],[{type:'system',threadId:'thread-a'},done]] });
    const executor = new RunExecutor({ agent, activeRuns: new ActiveRuns(), pool: new ProcessPool(()=>1) });
    const start = (scopeId: string) => startRunFlow({ scopeId, scope:{source:'im',chatId:scopeId,actorId:'u'},
      prompt:'question',attachments:[],access:{ok:true,reason:'allowed-user'},capability:codexCapability(profile),profileConfig:profile,
      sessions,sessionCatalog:catalog,workspaces:new WorkspaceStore(join(path,'workspaces')),executor,now:Date.now() });
    for (const group of ['a','b','a']) { const run=await start(group); if (!run.ok) throw new Error(run.rejectReason.userVisible); for await (const event of run.execution.subscribe()) {} }
    expect(agent.runOptions[0]!.cwd).not.toBe(agent.runOptions[1]!.cwd);
    expect(agent.runOptions[2]!.cwd).toBe(agent.runOptions[0]!.cwd);
    expect(agent.runOptions[2]!.threadId).toBe('thread-a');
    expect(catalog.resources.get('a')?.cwd).toBe(agent.runOptions[0]!.cwd);
  });
  it('does not spawn the agent after failed or cancelled preparation', async () => {
    const path = await root(); const activeRuns = new ActiveRuns(); const agent = new FakeAgentAdapter();
    const executor = new RunExecutor({ agent, activeRuns, pool: new ProcessPool(() => 1) });
    const policy = { ok: true as const, prompt: 'question', requestedCwd: path, cwdRealpath: path, accessMode: 'full' as const,
      sandbox: 'danger-full-access' as const, permissionMode: 'bypassPermissions' as const, access: { ok: true as const, reason: 'allowed-user' as const }, attachments: [], policyFingerprint: 'p', expiresAt: Date.now() + 60000 };
    const preparation = { prepare: (s: AbortSignal) => runSessionHook(hook("console.error('failed');process.exit(3)", path), path, s, identity), onEvent: () => {}, finish: async () => {} };
    await expect(executor.submit({ scopeId: 'a', policy, preparation })).rejects.toThrow('failed');
    const marker = join(path, 'started');
    const pending = executor.submit({ scopeId: 'a', policy, preparation: { ...preparation,
      prepare: (s) => runSessionHook(hook(`require('fs').writeFileSync(${JSON.stringify(marker)},'yes');setInterval(()=>{},100)`), path, s, identity) } });
    const checked = pending.catch((error: Error) => error);
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('yes'));
    expect(activeRuns.interrupt('a')).toBe(true);
    expect((await checked) instanceof Error).toBe(true); expect(agent.runOptions).toHaveLength(0);
  });
});
