import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import type { AgentEvent, AgentRunOptions } from '../../src/agent/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('Codex app-server process contract', () => {
  it('uses one server for multiple turns, preserves profile env and resumes the stored thread', async () => {
    const h = await harness();
    const first = h.adapter.run(h.options);
    const firstEvents = await collect(first.events); await first.reap?.();
    expect(firstEvents).toContainEqual({ type: 'final_text', content: 'answer' });
    const second = h.adapter.run({ ...h.options, runId: 'second', threadId: 'thread-1', images: ['/tmp/image.png'] });
    await collect(second.events); await second.reap?.();
    let records = await h.records();
    expect(records.filter((r) => r.spawn)).toHaveLength(1);
    expect(records.find((r) => r.spawn)?.env).toMatchObject({ LARK_CHANNEL_PROFILE: 'qa-test', CODEX_HOME: join(h.dir, 'home') });
    expect(records.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    expect(records.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    expect(records.find((r) => r.method === 'thread/start')?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', cwd: h.dir });
    expect(records.filter((r) => r.method === 'turn/start')[1]?.params).toMatchObject({ input: [{ type: 'text', text: 'question' }, { type: 'localImage', path: '/tmp/image.png' }] });
    await h.adapter.endSession(h.dir);
    const third = h.adapter.run({ ...h.options, runId: 'resumed', threadId: 'thread-1' });
    await collect(third.events); await third.reap?.();
    records = await h.records();
    expect(records.filter((r) => r.spawn)).toHaveLength(2);
    expect(records.some((r) => r.method === 'thread/resume')).toBe(true);
  });

  it('steers an active turn with identity, images and message id; rejects steering after completion', async () => {
    const h = await harness('steer');
    const run = h.adapter.run(h.options);
    const consumed = collect(run.events);
    expect(await run.steer!({ prompt: '追加要求', messageId: 'message-2', images: ['/tmp/second.png'] })).toBe(true);
    await consumed; await run.reap?.();
    expect(await run.steer!({ prompt: 'too late', messageId: 'message-3' })).toBe(false);
    const record = (await h.records()).find((r) => r.method === 'turn/steer');
    expect(record?.params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'message-2', input: [{ type: 'text', text: '追加要求' }, { type: 'localImage', path: '/tmp/second.png' }] });
  });

  it('keeps uncertain steer delivery visible and never repeats the request', async () => {
    const h = await harness('steer-timeout', 5000);
    const run = h.adapter.run(h.options);
    const consumed = collect(run.events);
    await expect(run.steer!({ prompt: 'uncertain', messageId: 'message-2' })).rejects.toThrow('outcome is unknown');
    await run.stop(); await consumed; await run.reap?.();
    expect((await h.records()).filter((r) => r.method === 'turn/steer')).toHaveLength(1);
  }, 20_000);

  it('interrupts the current turn without killing the session server', async () => {
    const h = await harness('interrupt');
    const run = h.adapter.run(h.options);
    const consumed = collect(run.events);
    await run.stop();
    expect(await consumed).toContainEqual({ type: 'done', threadId: 'thread-1', terminationReason: 'interrupted' });
    await run.reap?.();
    expect((await h.records()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
    const next = h.adapter.run({ ...h.options, runId: 'next' });
    const nextEvents = collect(next.events); await next.stop(); await nextEvents; await next.reap?.();
    expect((await h.records()).filter((r) => r.spawn)).toHaveLength(1);
  });

  it('reports process failure and recovers the same persisted thread on the next run', async () => {
    const h = await harness('crash');
    const first = h.adapter.run(h.options);
    expect((await collect(first.events)).some((e) => e.type === 'error' && e.message.includes('exited'))).toBe(true);
    await first.reap?.();
    const next = h.adapter.run({ ...h.options, runId: 'next', threadId: 'thread-1' });
    await collect(next.events); await next.reap?.();
    expect((await h.records()).filter((r) => r.method === 'thread/resume')).toHaveLength(1);
  });

  it('rejects a server that did not load the session rule snapshot', async () => {
    const h = await harness('missing-rules');
    await writeFile(join(h.dir, 'AGENTS.md'), '# QA rules');
    const run = h.adapter.run(h.options);
    expect((await collect(run.events)).some((e) => e.type === 'error' && e.message.includes('AGENTS.md'))).toBe(true);
  });

  it('waits for background terminal cleanup and reports failure before releasing the server', async () => {
    const h = await harness('cleanup-failure');
    const run = h.adapter.run(h.options); await collect(run.events);
    await expect(run.reap?.()).rejects.toThrow('cleanup failed');
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const results: AgentEvent[] = []; for await (const event of events) results.push(event); return results;
}

type RecordValue = { spawn?: boolean; env?: Record<string, string>; method?: string; params?: Record<string, unknown> };
async function harness(mode = 'normal', rpcTimeoutMs = 5000) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-server-test-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const record = join(dir, 'records.jsonl');
  const binary = join(dir, 'codex.mjs');
  await writeFile(binary, `#!${process.execPath}\n` + String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const record = process.env.TEST_RECORD;
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
` .replace('process.env.TEST_RECORD', JSON.stringify(record)) + `\nconst mode = ${JSON.stringify(mode)};\n` + String.raw`
const send = (value) => process.stdout.write(JSON.stringify(value)+'\n');
appendFileSync(record,JSON.stringify({spawn:true,argv:process.argv.slice(2),env:{CODEX_HOME:process.env.CODEX_HOME,LARK_CHANNEL_PROFILE:process.env.LARK_CHANNEL_PROFILE}})+'\n');
let turn=0;
const done=(status='completed')=>send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-'+turn,status,items:[],error:null}}});
const answer=()=>{send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-'+turn,item:{id:'answer-'+turn,type:'agentMessage',phase:'final_answer',text:'answer'}}});done();};
const rl=createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);appendFileSync(record,JSON.stringify(m)+'\n');
 if(!m.id)return;
 const reply=result=>send({id:m.id,result});
 if(m.method==='initialize')reply({userAgent:'fake'});
 else if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:'thread-1'},model:'test-model',instructionSources:mode==='missing-rules'?[]:[process.cwd()+'/AGENTS.md']});
 else if(m.method==='turn/start'){
  turn++;reply({turn:{id:'turn-'+turn}});send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-'+turn}}});
  if(mode==='crash')process.exit(42);
  if(!['steer','steer-timeout','interrupt'].includes(mode))setTimeout(answer,10);
 }else if(m.method==='turn/steer'){
  if(mode==='steer-timeout')return;
  reply({turnId:'turn-'+turn});setTimeout(answer,10);
 }else if(m.method==='turn/interrupt'){reply({});done('interrupted');}
 else if(m.method==='thread/backgroundTerminals/clean'){
  if(mode==='cleanup-failure')send({id:m.id,error:{code:-1,message:'cleanup failed'}});else reply({});
 }else send({id:m.id,error:{code:-32601,message:'unknown method'}});
});
rl.on('close',()=>process.exit(0));
`);
  await chmod(binary, 0o755);
  const adapter = new CodexAdapter({ binary, profileStateDir: dir, codexHome: join(dir, 'home'), sandbox: 'read-only', rpcTimeoutMs,
    larkChannel: { profile: 'qa-test' } });
  cleanups.push(() => adapter.dispose());
  const options: AgentRunOptions = { runId: 'first', scopeId: 'scope-1', sessionKey: 'logical-1', cwd: dir, prompt: 'question' };
  return { dir, adapter, options, records: async (): Promise<RecordValue[]> => (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) };
}
