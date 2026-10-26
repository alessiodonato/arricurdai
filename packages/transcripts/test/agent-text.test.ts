import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { isMemoryFile, parseSession } from '../src/index';

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const toolCall = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', cwd: '/repo', message: { id, content: [{ type: 'tool_use', id: `t-${id}`, name, input }], usage } });

test('recognizes memory files by name and folder', () => {
  expect(['/repo/CLAUDE.md', '/repo/app/CLAUDE.local.md', '/repo/.claude/rules/a.md', '/home/me/.claude/projects/x/memory/MEMORY.md'].map(isMemoryFile)).toEqual([true, true, true, true]);
  expect(['/repo/src/claude.ts', '/repo/docs/CLAUDE.txt', '/repo/README.md'].map(isMemoryFile)).toEqual([false, false, false]);
});

test('the text written into a memory file is not agent text, the text written into code is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arricurdai-text-'));
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, [
      toolCall('m1', 'Write', { file_path: '/repo/CLAUDE.md', content: 'Run `pnpm magic` before committing.' }),
      toolCall('m2', 'Edit', { file_path: '/repo/src/db.ts', old_string: 'query(', new_string: 'withTransaction(query(' }),
    ].join('\n'));
    const session = await parseSession({ sessionId: 's', file, subagents: [] });
    expect(session.agentText).toContain('/repo/CLAUDE.md');
    expect(session.agentText.join('\n')).not.toContain('pnpm magic');
    expect(session.agentText).toContain('withTransaction(query(');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
