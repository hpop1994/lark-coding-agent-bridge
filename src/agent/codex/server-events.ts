import type { AgentEvent } from '../types';
import { object, string, type ObjectValue } from './rpc';

const TOOL_ITEMS = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch',
  'collabAgentToolCall', 'subAgentActivity', 'imageView', 'imageGeneration', 'sleep']);

export class EventQueue implements AsyncIterable<AgentEvent> {
  private values: AgentEvent[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: AgentEvent): void {
    if (this.ended) return;
    this.values.push(value);
    this.wake?.();
  }
  end(): void { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    while (true) {
      while (this.values.length) yield this.values.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

/** Translates one turn; an absent phase is valid provider output. */
export class ServerEvents {
  private pendingAnswer?: { id: string; text: string };
  private published = new Set<string>();
  constructor(private readonly queue: EventQueue) {}

  notification(method: string, params: ObjectValue): void {
    if (method === 'item/started') {
      const item = object(params.item);
      if (item.type !== 'agentMessage') this.flushProgress();
      if (TOOL_ITEMS.has(String(item.type))) {
        this.queue.push({ type: 'tool_use', id: string(item.id), name: string(item.type), input: item });
      }
    } else if (method === 'item/completed') {
      const item = object(params.item);
      const id = string(item.id);
      if (item.type === 'agentMessage') {
        if (this.published.has(id)) return;
        this.published.add(id);
        this.flushProgress();
        const text = string(item.text);
        if (item.phase === 'commentary') this.queue.push({ type: 'text', delta: text });
        else this.pendingAnswer = { id, text };
      } else if (TOOL_ITEMS.has(String(item.type))) {
        this.queue.push({ type: 'tool_result', id, output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : JSON.stringify(item),
          isError: item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0) });
      }
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = object(object(params.tokenUsage).last);
      this.queue.push({ type: 'usage', inputTokens: Number(usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0),
        cachedInputTokens: Number(usage.cachedInputTokens ?? 0), reasoningOutputTokens: Number(usage.reasoningOutputTokens ?? 0) });
    }
  }

  finish(threadId: string, turn: ObjectValue): void {
    if (turn.status === 'completed') {
      if (this.pendingAnswer) this.queue.push({ type: 'final_text', content: this.pendingAnswer.text });
      this.queue.push({ type: 'done', threadId, terminationReason: 'normal' });
    } else if (turn.status === 'interrupted') {
      this.flushProgress();
      this.queue.push({ type: 'done', threadId, terminationReason: 'interrupted' });
    } else {
      this.flushProgress();
      const error = object(turn.error);
      this.queue.push({ type: 'error', message: string(error.message), terminationReason: 'failed' });
    }
    this.queue.end();
  }

  private flushProgress(): void {
    if (!this.pendingAnswer) return;
    this.queue.push({ type: 'text', delta: this.pendingAnswer.text });
    this.pendingAnswer = undefined;
  }
}
