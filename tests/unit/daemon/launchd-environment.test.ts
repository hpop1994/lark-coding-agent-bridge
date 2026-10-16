import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ directory: '', spawnSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawnSync: mocks.spawnSync,
}));
vi.mock('../../../src/daemon/paths', async (original) => ({
  ...await original<typeof import('../../../src/daemon/paths')>(),
  launchAgentPlistPath: () => join(mocks.directory, 'service.plist'),
  daemonLogDir: () => join(mocks.directory, 'logs'),
}));

import { writePlist } from '../../../src/daemon/launchd';

describe('launchd service environment', () => {
  beforeEach(async () => {
    mocks.directory = await mkdtemp(join(tmpdir(), 'bridge-launchd-env-'));
    mocks.spawnSync.mockReset();
  });
  afterEach(async () => { await rm(mocks.directory, { recursive: true, force: true }); });

  it('retains provisioned credentials and PATH when reinstalling from a minimal shell', async () => {
    const plist = join(mocks.directory, 'service.plist');
    await writeFile(plist, 'original plist', { mode: 0o644 });
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ EnvironmentVariables: {
      AZURE_OPENAI_API_KEY: 'test-only<&credential', PATH: '/provisioned/bin:/usr/bin', LARK_CHANNEL_HOME: '/old-home',
    } }) });
    await writePlist('qa', ['run', '--profile', 'qa']);
    const content = await readFile(plist, 'utf8');
    expect(content).toContain('<key>AZURE_OPENAI_API_KEY</key>\n        <string>test-only&lt;&amp;credential</string>');
    expect(content).toContain('<string>/provisioned/bin:/usr/bin</string>');
    expect(content).not.toContain('/old-home');
    expect(mocks.spawnSync).toHaveBeenCalledWith('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
    if (process.platform !== 'win32') expect((await stat(plist)).mode & 0o777).toBe(0o600);
  });

  it.each([
    { status: 1, stdout: '' },
    { status: 0, stdout: '{invalid' },
    { status: 0, stdout: JSON.stringify({ EnvironmentVariables: { KEY: 42 } }) },
  ])('keeps the old plist intact when its environment cannot be read: %j', async (result) => {
    const plist = join(mocks.directory, 'service.plist');
    await writeFile(plist, 'original plist');
    mocks.spawnSync.mockReturnValue(result);
    await expect(writePlist('qa')).rejects.toThrow(/launchd/);
    expect(await readFile(plist, 'utf8')).toBe('original plist');
  });

  it('creates a new service without reading shell secrets', async () => {
    await writePlist('qa');
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(await readFile(join(mocks.directory, 'service.plist'), 'utf8')).toContain('<key>PATH</key>');
  });
});
