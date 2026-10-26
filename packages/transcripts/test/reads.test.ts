import { describe, expect, test } from 'vitest';
import { classifyToolCall, readKey, relativeToRoot } from '../src/index';

const ROOT = '/home/dev/shop';

describe('relativeToRoot', () => {
  test('makes paths inside the root relative and keeps the others', () => {
    expect(relativeToRoot('/home/dev/shop/src/a.ts', ROOT)).toBe('src/a.ts');
    expect(relativeToRoot('/home/dev/shop', ROOT)).toBe('.');
    expect(relativeToRoot('/tmp/x.txt', ROOT)).toBe('/tmp/x.txt');
    expect(relativeToRoot('/home/dev/shop-old/a.ts', ROOT)).toBe('/home/dev/shop-old/a.ts');
  });
});

describe('classifyToolCall', () => {
  test('Read reads a file', () => {
    expect(classifyToolCall('Read', { file_path: '/home/dev/shop/src/a.ts', offset: 1, limit: 200 }, ROOT, ROOT)).toEqual({
      reads: [{ tool: 'Read', kind: 'file', target: 'src/a.ts' }],
      changes: [],
    });
  });

  test('Grep searches a pattern, Glob lists files', () => {
    expect(classifyToolCall('Grep', { pattern: 'TODO', path: 'src', glob: '*.ts' }, ROOT, ROOT).reads).toEqual([
      { tool: 'Grep', kind: 'search', target: 'TODO', scope: 'src', filter: '*.ts' },
    ]);
    expect(classifyToolCall('Grep', { pattern: 'TODO' }, `${ROOT}/src`, ROOT).reads[0]?.scope).toBe('src');
    expect(classifyToolCall('Glob', { pattern: '**/*.test.ts' }, ROOT, ROOT).reads).toEqual([
      { tool: 'Glob', kind: 'list', target: '.', filter: '**/*.test.ts' },
    ]);
  });

  test('Bash reads relative to the folder it ran in', () => {
    expect(classifyToolCall('Bash', { command: 'grep -rn "applyDiscount" src' }, ROOT, ROOT).reads).toEqual([
      { tool: 'grep', kind: 'search', target: 'applyDiscount', scope: 'src' },
    ]);
    expect(classifyToolCall('Bash', { command: 'cat orders.ts' }, `${ROOT}/src/db`, ROOT).reads[0]?.target).toBe('src/db/orders.ts');
  });

  test('Edit, MultiEdit, Write, NotebookEdit and writing Bash commands change files', () => {
    expect(classifyToolCall('Edit', { file_path: `${ROOT}/src/a.ts` }, ROOT, ROOT).changes).toEqual([{ path: 'src/a.ts', tool: 'Edit' }]);
    expect(classifyToolCall('MultiEdit', { file_path: `${ROOT}/b.ts` }, ROOT, ROOT).changes).toEqual([{ path: 'b.ts', tool: 'MultiEdit' }]);
    expect(classifyToolCall('Write', { file_path: `${ROOT}/c.ts`, content: 'x' }, ROOT, ROOT).changes).toEqual([{ path: 'c.ts', tool: 'Write' }]);
    expect(classifyToolCall('NotebookEdit', { notebook_path: `${ROOT}/n.ipynb` }, ROOT, ROOT).changes).toEqual([{ path: 'n.ipynb', tool: 'NotebookEdit' }]);
    expect(classifyToolCall('Bash', { command: "sed -i 's/a/b/' x.ts" }, ROOT, ROOT).changes).toEqual([{ path: 'x.ts', tool: 'Bash' }]);
  });

  test('other tools neither read nor change files', () => {
    expect(classifyToolCall('Agent', { prompt: 'look around' }, ROOT, ROOT)).toEqual({ reads: [], changes: [] });
    expect(classifyToolCall('Bash', { command: 'pnpm test' }, ROOT, ROOT)).toEqual({ reads: [], changes: [] });
    expect(classifyToolCall('Read', {}, ROOT, ROOT)).toEqual({ reads: [], changes: [] });
  });
});

describe('readKey', () => {
  test('groups reads by kind, so cat and Read of the same file match', () => {
    const viaRead = classifyToolCall('Read', { file_path: `${ROOT}/src/pricing.ts` }, ROOT, ROOT).reads[0]!;
    const viaSed = classifyToolCall('Bash', { command: "sed -n '1,40p' src/pricing.ts" }, ROOT, ROOT).reads[0]!;
    expect(readKey(viaRead)).toBe('file:src/pricing.ts');
    expect(readKey(viaSed)).toBe(readKey(viaRead));
  });

  test('includes the scope of a search and the filter of a listing', () => {
    expect(readKey({ kind: 'search', target: 'TODO', scope: 'src', filter: '*.ts' })).toBe('search:TODO @ src [*.ts]');
    expect(readKey({ kind: 'list', target: 'src', filter: '-name *.test.ts' })).toBe('list:src [-name *.test.ts]');
    expect(readKey({ kind: 'list', target: 'src' })).toBe('list:src');
  });
});
