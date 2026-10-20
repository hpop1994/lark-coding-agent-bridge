import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import { sessionAutoResetMinutes } from '../config/session-lifecycle';
import type { SessionCatalog, SessionCatalogIdentity } from './catalog';
import type { SessionStore } from './store';
import { runSessionHook, SessionHookError } from './hook';
import { RunRejected } from '../runtime/errors';
import { log } from '../core/logger';

export interface RunPreparation {
  prepare(signal: AbortSignal): Promise<{ sessionId?: string; threadId?: string; prompt?: string; cwd?: string; sessionKey?: string }>;
  cancel?(): Promise<void>;
  onEvent(event: AgentEvent): void;
  finish(): Promise<void>;
}

export function sessionLifecycle(input: {
  identity: SessionCatalogIdentity;
  profile: ProfileConfig;
  sessions: SessionStore;
  catalog?: SessionCatalog;
  now?: () => number;
  requestedAt?: number;
  resetPrompt?: string;
  profileName?: string;
  chatId?: string;
  threadId?: string;
  onWorkspace?: (cwd: string, prompt?: string) => Promise<void>;
  onReset?: (minutes: number) => Promise<void>;
  onPreparing?: () => Promise<void>;
}): RunPreparation & { resumeFrom?: string } {
  const now = input.now ?? Date.now;
  let recordedSession: string | undefined;
  let resourceId: string | undefined;
  let createdResource = false;
  let releaseResource: (() => void) | undefined;
  const result: RunPreparation & { resumeFrom?: string } = {
    async prepare(signal) {
      signal.throwIfAborted();
      const { identity, profile, sessions, catalog } = input;
      const resources = catalog?.resources;
      if (resources) {
        releaseResource = resources.claim(identity.scopeId);
        if (!releaseResource) throw new RunRejected('run-already-active', '会话正在结束，请稍后重试。');
      }
      let resource = resources?.get(identity.scopeId);
      const entry = catalog?.activeFor(identity);
      const minutes = sessionAutoResetMinutes(profile.preferences.sessionAutoResetMinutes);
      const legacy = identity.agentId === 'claude' && !entry ? sessions.getRaw(identity.scopeId) : undefined;
      const candidate = entry?.sessionId ?? entry?.threadId ??
        (legacy?.cwd === identity.cwdRealpath ? legacy.sessionId : undefined);
      const completedAt = resource?.lastCompletedAt ?? entry?.lastCompletedAt ?? entry?.updatedAt ?? legacy?.updatedAt;
      const expired = Boolean((candidate || resource?.phase === 'active') && minutes > 0 && completedAt !== undefined &&
        (input.requestedAt ?? now()) - completedAt >= minutes * 60000);
      const requestedReason = resources?.requestedReason(identity.scopeId);
      const ended = requestedReason || resource?.phase === 'ending' || resource?.phase === 'ended';
      const changed = resource && (resource.agentId !== identity.agentId || resource.baseCwd !== identity.cwdRealpath || resource.fingerprint !== identity.policyFingerprint);
      const incomplete = resource?.phase === 'preparing';
      const replacing = Boolean(ended || changed || incomplete || expired);
      const idleReset = expired || (resource?.phase === 'ended' && resource.endReason === 'idle_timeout');
      if (replacing) {
        if (resources && resource) await resources.end(identity.scopeId,
          requestedReason ?? (expired ? 'idle_timeout' : incomplete ? 'prepare_interrupted' : 'session_replaced'), signal);
        resource = undefined;
        catalog?.archiveActive({ ...identity, now: now() });
        sessions.clear(identity.scopeId);
        await catalog?.flush();
        await sessions.flush();
        log.info('session', 'reset', { scopeId: identity.scopeId, minutes, previous: candidate, idleReset });
        if (idleReset) await input.onReset?.(minutes);
      }
      result.resumeFrom = replacing ? undefined : candidate;
      recordedSession = result.resumeFrom;
      try {
        if (resources && !resource) {
          // A configured preparer owns the new session, never an old unbound thread.
          if (profile.hooks?.beforeSessionStart && result.resumeFrom) {
            result.resumeFrom = undefined;
            recordedSession = undefined;
            catalog?.archiveActive(identity);
            sessions.clear(identity.scopeId);
          }
          if (!result.resumeFrom && profile.hooks?.beforeSessionStart) await input.onPreparing?.();
          createdResource = true;
          resource = await resources.create({
            scopeId: identity.scopeId, agentId: identity.agentId, profile: input.profileName ?? 'unknown',
            baseCwd: identity.cwdRealpath, fingerprint: identity.policyFingerprint,
            hooks: profile.hooks ?? {}, chatId: input.chatId, threadId: input.threadId,
          }, signal);
        } else if (!resources && !result.resumeFrom && profile.hooks?.beforeSessionStart) {
          await input.onPreparing?.();
          await runSessionHook(profile.hooks.beforeSessionStart, identity.cwdRealpath, signal, identity);
        }
        resourceId = resource?.id;
        await input.onWorkspace?.(resource?.cwd ?? identity.cwdRealpath, replacing ? input.resetPrompt : undefined);
      } catch (err) {
        if (signal.aborted) throw new RunRejected('run-cancelled', '新会话准备已取消，本轮对话未启动。');
        if (err instanceof SessionHookError) throw new RunRejected('session-hook-failed', err.message);
        throw err;
      }
      signal.throwIfAborted();
      return {
        sessionKey: resource?.id ?? identity.scopeId,
        cwd: resource?.cwd ?? identity.cwdRealpath,
        ...(identity.agentId === 'claude' ? { sessionId: result.resumeFrom } : { threadId: result.resumeFrom }),
        ...(replacing && input.resetPrompt !== undefined ? { prompt: input.resetPrompt } : {}),
      };
    },
    onEvent(event) {
      if (event.type !== 'system') return;
      const id = input.identity.agentId === 'claude' ? event.sessionId : event.threadId;
      if (!id) return;
      recordedSession = id;
      if (input.identity.agentId === 'claude') {
        input.sessions.set(input.identity.scopeId, id, input.identity.cwdRealpath);
      }
      input.catalog?.upsertActive({ ...input.identity, now: now(),
        ...(input.identity.agentId === 'claude' ? { sessionId: id } : { threadId: id }) });
    },
    async cancel() {
      try {
        if (input.catalog?.resources.get(input.identity.scopeId) && (createdResource || input.catalog.resources.get(input.identity.scopeId)?.phase === 'preparing')) {
          await input.catalog.resources.end(input.identity.scopeId, 'prepare_failed', new AbortController().signal);
        }
      } finally { releaseResource?.(); }
    },
    async finish() {
      try {
      if (resourceId) await input.catalog?.resources.complete(input.identity.scopeId, resourceId, now());
      if (recordedSession) input.catalog?.complete(input.identity, recordedSession, now());
      await input.catalog?.flush();
      await input.sessions.flush();
      } finally { releaseResource?.(); }
    },
  };
  return result;
}
