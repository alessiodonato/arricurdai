import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBash, readEdits, renderEdits, runEdits, withoutHeredocs } from '../src/edits';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T12:00:00Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const SHOP = '/work/shop-api';

const tool = (cwd: string, at: string, name: string, input: object, mode = 'auto'): string =>
  JSON.stringify({ type: 'assistant', cwd, timestamp: at, permissionMode: mode, message: { content: [{ type: 'tool_use', id: 't', name, input }] } });

function claudeDir(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'arricurdai-edits-'));
  const path = join(dir, 'projects', '-work-shop-api', 'aaaa1111.jsonl');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
  utimesSync(path, NOW, NOW);
  return dir;
}

describe('a Bash command', () => {
  it('is a shell write when its line names a file of the project', () => {
    expect(classifyBash("sed -i '' 's/retry/retries/' src/api.ts", SHOP)).toBe('shell');
    expect(classifyBash('echo "export {}" >> src/api.ts', SHOP)).toBe('shell');
    expect(classifyBash("cat > src/config.ts <<'EOF'\nexport const a = b > c; // it's fine\nEOF", SHOP)).toBe('shell');
    expect(classifyBash('cd src && cp api.ts api.old.ts', SHOP)).toBe('shell');
  });

  it('is a script when it runs code that writes files', () => {
    expect(classifyBash("python3 - <<'PY'\nopen('src/api.ts', 'w').write('x')\nPY", SHOP)).toBe('script');
    expect(classifyBash(`node -e "require('fs').writeFileSync('a.json', '{}')"`, SHOP)).toBe('script');
  });

  it('is a script whose file is not known when the code does not name it, and nothing when it writes elsewhere', () => {
    expect(classifyBash("python3 - <<'PY'\nopen(out, 'w').write('x')\nPY", SHOP)).toBe('script-unnamed');
    expect(classifyBash("python3 -c \"open('/tmp/x.txt', 'w').write('x')\"", SHOP)).toBeUndefined();
    expect(classifyBash("python3 -c 'import json, sys; json.dump({}, sys.stdout)'", SHOP)).toBeUndefined();
  });

  it('is nothing when it writes outside the project, only reads, or only runs tests', () => {
    expect(classifyBash('npm test > /tmp/test.log 2>&1', SHOP)).toBeUndefined();
    expect(classifyBash("grep -n 'retry' src/api.ts", SHOP)).toBeUndefined();
    expect(classifyBash('echo x > .git/info/exclude', SHOP)).toBeUndefined();
    expect(classifyBash("python3 -c 'print(1)'", SHOP)).toBeUndefined();
  });

  it('cannot be told when it needs running: $(...)', () => {
    expect(classifyBash('echo $(date) > when.txt', SHOP)).toBe('unreadable');
  });

  it('loses the bodies of its here-documents, and their <<WORD', () => {
    expect(withoutHeredocs("cat > a.md <<'EOF'\nbody > b.md\nEOF\nls")).toBe('cat > a.md \nls');
    expect(withoutHeredocs('cat <<-END > a.md\n\tbody\n\tEND')).toBe('cat  > a.md');
  });
});

describe('the edits of the last days', () => {
  const lines = [
    tool(SHOP, ago(1 * DAY), 'Edit', { file_path: `${SHOP}/src/api.ts`, old_string: 'a', new_string: 'b' }, 'default'),
    tool(SHOP, ago(1 * DAY), 'Write', { file_path: 'src/new.ts', content: 'SECRET-CONTENT' }),
    tool(SHOP, ago(2 * DAY), 'Bash', { command: "sed -i '' 's/a/b/' src/api.ts" }),
    tool(SHOP, ago(2 * DAY), 'Bash', { command: "cat > src/b.ts <<'EOF'\nSECRET-CONTENT\nEOF" }),
    tool(SHOP, ago(9 * DAY), 'Bash', { command: "python3 - <<'PY'\nopen('src/c.py', 'w').write('SECRET-CONTENT')\nPY" }),
    tool(SHOP, ago(3 * DAY), 'Bash', { command: 'npm test > /tmp/t.log' }),
    tool(SHOP, ago(3 * DAY), 'Read', { file_path: `${SHOP}/src/api.ts` }),
    tool(SHOP, ago(40 * DAY), 'Edit', { file_path: `${SHOP}/old.ts`, old_string: 'a', new_string: 'b' }),
  ];

  it('are counted by how they were made, by kind and by week', async () => {
    const report = await readEdits(claudeDir(lines), NOW, 14);
    expect(report).toMatchObject({ days: 14, sessions: 1, autoSessions: 1, tools: 2, shell: 2, scripts: 1, scriptsUnnamed: 0, unreadable: 0 });
    expect(report.shellKinds['here-document']).toBe(1);
    expect(report.shellKinds['sed -i']).toBe(1);
    expect(report.weeks).toEqual([
      { from: '2026-10-12', tools: 0, shell: 0, scripts: 1 },
      { from: '2026-10-19', tools: 2, shell: 2, scripts: 0 },
    ]);
  });

  it('are shown as counts only: no text, file or project name', async () => {
    const text = renderEdits(await readEdits(claudeDir(lines), NOW, 14));
    expect(text).toContain('with Edit, Write, MultiEdit or NotebookEdit');
    expect(text).toMatch(/with a shell command \(sed -i, >, tee, cp…\)\s+2\s+40%/);
    expect(text).not.toContain('SECRET-CONTENT');
    expect(text).not.toContain('shop-api');
    expect(text).not.toContain('api.ts');
  });

  it('say so when nothing changed, and refuse a wrong --days', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { cwd: '/', env: { CLAUDE_CONFIG_DIR: claudeDir([]) }, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), now: () => NOW, colors: false };
    expect(await runEdits({}, io)).toBe(0);
    expect(out.join('')).toContain('No Claude Code session changed a file');
    expect(await runEdits({ days: '0' }, io)).not.toBe(0);
    expect(err.join('')).toContain('--days');
  });
});
