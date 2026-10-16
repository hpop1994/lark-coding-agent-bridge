import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from './spawn';

/** Adapters spawn a private group so session resource disposal cannot race descendants. */
export async function reapProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', (code) => code === 0 ? resolve() : reject(new Error(`taskkill failed: ${code}`)));
    });
    return;
  }
  const signal = (value: NodeJS.Signals): boolean => {
    try { process.kill(-child.pid!, value); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false; throw err; }
  };
  if (!signal('SIGTERM')) return;
  await new Promise((resolve) => setTimeout(resolve, 100));
  signal('SIGKILL');
}
