import type { ProfileSession, SessionContext, SessionRead, Usage } from '../src/index';

/** One API call with round numbers: 1-hour cache writes, so a block written once costs 2 per token. */
export const call = (overrides: Partial<Usage> = {}): { usage: Usage } => ({
  usage: { input: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, ...overrides },
});

export const calls = (count: number): { usage: Usage }[] => Array.from({ length: count }, () => call());

export function read(key: string, overrides: Partial<SessionRead> = {}): SessionRead {
  const [kind, target] = key.split(':') as [SessionRead['kind'], string];
  return { key, kind, target, tokens: 100, resultHash: 'h', turn: 2, timestamp: undefined, isError: false, ...overrides };
}

export function context(overrides: Partial<SessionContext> = {}): SessionContext {
  return { kind: 'main', calls: calls(10), compactions: [], reads: [], memory: [], cacheTtl: '1h', ...overrides };
}

export function session(sessionId: string, startedAt: string, overrides: Partial<ProfileSession> = {}): ProfileSession {
  return {
    sessionId, startedAt, root: '/repo', main: context(), subagents: [], fileChanges: [], agentText: [],
    unrecordedUsage: undefined, recordsMemory: true, ...overrides,
  };
}
