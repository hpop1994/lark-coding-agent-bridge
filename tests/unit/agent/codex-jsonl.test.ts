import { describe, expect, it } from 'vitest';
import { EventQueue, ServerEvents } from '../../../src/agent/codex/server-events';
import type { AgentEvent } from '../../../src/agent/types';

async function translated(items: Array<{ method: string; params: Record<string, unknown> }>, status = 'completed') {
  const queue = new EventQueue(); const translator = new ServerEvents(queue);
  for (const event of items) translator.notification(event.method, event.params);
  translator.finish('thread-1', { status, error: { message: 'failed turn' } });
  const result: AgentEvent[] = []; for await (const event of queue) result.push(event); return result;
}
const message = (id: string, text: string, phase?: string) => ({ method: 'item/completed', params: { item: { type: 'agentMessage', id, text, phase } } });
describe('app-server turn events', () => {
  it('separates commentary from the final answer and ignores duplicate item delivery', async () => {
    expect(await translated([message('a','working','commentary'), message('b','answer','final_answer'), message('b','answer','final_answer')])).toEqual([
      { type:'text',delta:'working' },{ type:'final_text',content:'answer' },{ type:'done',threadId:'thread-1',terminationReason:'normal' },
    ]);
  });
  it('uses turn boundaries to classify legal provider output without a phase', async () => {
    expect(await translated([message('a','first'),message('b','last')])).toEqual([
      { type:'text',delta:'first' },{ type:'final_text',content:'last' },{ type:'done',threadId:'thread-1',terminationReason:'normal' },
    ]);
  });
  it('flushes text followed by tool activity as progress and maps failed commands', async () => {
    expect(await translated([message('a','checking'),
      { method:'item/started',params:{ item:{ type:'commandExecution',id:'tool',command:'false' } } },
      { method:'item/completed',params:{ item:{ type:'commandExecution',id:'tool',exitCode:1,aggregatedOutput:'error' } } },
      message('b','answer')])).toEqual([
      { type:'text',delta:'checking' },{ type:'tool_use',id:'tool',name:'commandExecution',input:{ type:'commandExecution',id:'tool',command:'false' } },
      { type:'tool_result',id:'tool',isError:true,output:'error' },{ type:'final_text',content:'answer' },{ type:'done',threadId:'thread-1',terminationReason:'normal' },
    ]);
  });
  it('does not publish an unfinished answer as a successful final response', async () => {
    expect(await translated([message('a','partial')],'failed')).toEqual([
      { type:'text',delta:'partial' },{ type:'error',message:'failed turn',terminationReason:'failed' },
    ]);
  });
  it('preserves interruption and current-turn token usage', async () => {
    expect(await translated([{ method:'thread/tokenUsage/updated',params:{ tokenUsage:{ last:{inputTokens:10,outputTokens:4,cachedInputTokens:2,reasoningOutputTokens:1} } } }],'interrupted')).toEqual([
      {type:'usage',inputTokens:10,outputTokens:4,cachedInputTokens:2,reasoningOutputTokens:1},
      {type:'done',threadId:'thread-1',terminationReason:'interrupted'},
    ]);
  });
});
