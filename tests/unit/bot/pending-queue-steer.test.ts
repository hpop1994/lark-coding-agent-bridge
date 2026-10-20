import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { PendingQueue } from '../../../src/bot/pending-queue';
const message = (id: string) => ({ messageId:id }) as NormalizedMessage;
afterEach(() => vi.useRealTimers());
function gate<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>((r)=>{resolve=r;}); return {promise,resolve}; }
describe('pending queue steering handoff', () => {
  it('steers messages accumulated during preparation, serializes deliveries and keeps order', async () => {
    vi.useFakeTimers();const flushed=vi.fn();const queue=new PendingQueue(600,flushed);const first=gate<boolean>();const steer=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
    queue.block('a');queue.push('a',message('1'));await vi.advanceTimersByTimeAsync(1000);expect(steer).not.toHaveBeenCalled();
    queue.setSteering('a',steer);await vi.advanceTimersByTimeAsync(600);queue.push('a',message('2'));await vi.advanceTimersByTimeAsync(1000);expect(steer).toHaveBeenCalledTimes(1);
    first.resolve(true);await vi.advanceTimersByTimeAsync(600);expect(steer.mock.calls.map(c=>c[0].map((m:NormalizedMessage)=>m.messageId))).toEqual([['1'],['2']]);expect(flushed).not.toHaveBeenCalled();queue.cancelAll();
  });
  it('restores declined delivery ahead of later messages and waits for cleanup release', async () => {
    vi.useFakeTimers();const flushed=vi.fn();const queue=new PendingQueue(600,flushed);const attempt=gate<boolean>();queue.block('a');queue.setSteering('a',()=>attempt.promise);
    queue.push('a',message('1'));await vi.advanceTimersByTimeAsync(600);queue.push('a',message('2'));attempt.resolve(false);await vi.advanceTimersByTimeAsync(5000);expect(flushed).not.toHaveBeenCalled();
    queue.unblock('a');await vi.advanceTimersByTimeAsync(600);expect(flushed.mock.calls[0]?.[1].map((m:NormalizedMessage)=>m.messageId)).toEqual(['1','2']);queue.cancelAll();
  });
  it('does not resurrect cancelled messages when an in-flight steer declines', async () => {
    vi.useFakeTimers();const flushed=vi.fn();const queue=new PendingQueue(600,flushed);const attempt=gate<boolean>();queue.block('a');queue.setSteering('a',()=>attempt.promise);
    queue.push('a',message('1'));await vi.advanceTimersByTimeAsync(600);queue.cancel('a');queue.unblock('a');attempt.resolve(false);await vi.advanceTimersByTimeAsync(3000);expect(flushed).not.toHaveBeenCalled();queue.cancelAll();
  });
});
