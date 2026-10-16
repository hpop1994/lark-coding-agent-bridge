import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnProcess } from '../../../src/platform/spawn';
import { reapProcessGroup } from '../../../src/platform/process-group';

describe('session process group disposal', () => {
  it.skipIf(process.platform === 'win32')('reaps descendants after the Agent parent has already exited', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'process-group-')));
    const marker = join(directory, 'survived');
    const childCode = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),600)`;
    const parentCode = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'}).unref()`;
    const child = spawnProcess(process.execPath, ['-e', parentCode], { detached: true, stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
      await reapProcessGroup(child);
      await new Promise((resolve) => setTimeout(resolve, 650));
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await reapProcessGroup(child); await rm(directory, { recursive: true, force: true }); }
  });
});
