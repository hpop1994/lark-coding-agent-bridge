import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', sessionKey: 'session-1', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin, never argv (cmd.exe would mangle it on Windows).
    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', sessionKey: 'session-1', prompt: 'hi', cwd: '/tmp' });

    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined));
  });

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});

describe('CodexAdapter system prompt wiring', () => {
  it.each([undefined, { openId: 'ou_bot_self', name: 'Bridge' }])('sends bridge instructions as developerInstructions (%j)', async (identity) => {
    const child = fakeChild();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const request = JSON.parse(line); requests.push(request);
        if (!request.id) continue;
        const result = request.method === 'thread/start' ? { thread: { id: 'thread-1' }, model: 'model', instructionSources: [] }
          : request.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
        child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
        if (request.method === 'turn/start') child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }) + '\n');
      }
    });
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new CodexAdapter({ binary: '/usr/local/bin/codex', profileStateDir: '/tmp/codex-profile' });
    if (identity) adapter.setBotIdentity(identity);
    const run = adapter.run({ runId: 'r1', sessionKey: 'session-1', prompt: 'hi', cwd: '/tmp' });
    for await (const event of run.events) { expect(event.type).toMatch(/system|done/); }
    expect(requests.find(r => r.method === 'thread/start')?.params.developerInstructions).toBe(buildBridgeSystemPrompt(identity));
    expect(requests.find(r => r.method === 'turn/start')?.params.input).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
