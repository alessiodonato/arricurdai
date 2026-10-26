import { describe, expect, test } from 'vitest';
import { analyzeBash, parseCommandLine } from '../src/index';

const ROOT = '/home/dev/shop';
const reads = (command: string, cwd = ROOT) => analyzeBash(command, cwd).reads;

describe('parseCommandLine', () => {
  test('removes quotes and keeps escaped characters', () => {
    expect(parseCommandLine(`grep -n "a b" 'c d' e\\ f "x\\"y"`)?.[0]?.words).toEqual(['grep', '-n', 'a b', 'c d', 'e f', 'x"y']);
  });

  test('splits on pipes, lists and newlines, and remembers what joins each command', () => {
    const commands = parseCommandLine('cd src && cat a.ts | head -5; ls\nwc -l x || true');
    expect(commands?.map((c) => [c.joinedBy, c.words[0]])).toEqual([
      [undefined, 'cd'], ['&&', 'cat'], ['|', 'head'], [';', 'ls'], [';', 'wc'], ['||', 'true'],
    ]);
  });

  test('reads redirects with their file descriptor', () => {
    expect(parseCommandLine('cat a 2>/dev/null >out.txt 2>&1')?.[0]?.redirects).toEqual([
      { op: '2>', target: '/dev/null' }, { op: '>', target: 'out.txt' }, { op: '2>&', target: '1' },
    ]);
  });

  test('gives up on constructs it cannot predict', () => {
    for (const command of ['cat $(ls)', 'cat `ls`', 'cat <<EOF\nx\nEOF', 'diff <(ls a) <(ls b)', '(cd a; ls)', 'echo "unbalanced']) {
      expect(parseCommandLine(command), command).toBeUndefined();
    }
  });

  test('ignores comments', () => {
    expect(parseCommandLine('ls # list the folder')?.[0]?.words).toEqual(['ls']);
  });
});

describe('analyzeBash: reads', () => {
  test('cat, head, tail and sed -n read files', () => {
    expect(reads('cat package.json')).toEqual([{ tool: 'cat', kind: 'file', paths: [`${ROOT}/package.json`] }]);
    expect(reads('head -n 50 a.ts b.ts').map((r) => r.paths[0])).toEqual([`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
    expect(reads('head -20 a.ts')).toEqual([{ tool: 'head', kind: 'file', paths: [`${ROOT}/a.ts`] }]);
    expect(reads('tail -f logs/app.log')).toEqual([{ tool: 'tail', kind: 'file', paths: [`${ROOT}/logs/app.log`] }]);
    expect(reads("sed -n '1,40p' src/pricing.ts")).toEqual([{ tool: 'sed', kind: 'file', paths: [`${ROOT}/src/pricing.ts`] }]);
    expect(reads('cat < src/a.ts')).toEqual([{ tool: 'cat', kind: 'file', paths: [`${ROOT}/src/a.ts`] }]);
  });

  test('grep and rg search a pattern in folders or files', () => {
    expect(reads('grep -rn "applyDiscount" src')).toEqual([{ tool: 'grep', kind: 'search', pattern: 'applyDiscount', paths: [`${ROOT}/src`], filter: undefined }]);
    expect(reads('grep -r --include=*.ts TODO .')[0]).toMatchObject({ pattern: 'TODO', paths: [ROOT], filter: '*.ts' });
    expect(reads('grep -A3 -e foo -e bar x.ts')[0]).toMatchObject({ pattern: 'foo|bar', paths: [`${ROOT}/x.ts`] });
    expect(reads("rg -n 'TODO' -g '*.ts'")).toEqual([{ tool: 'rg', kind: 'search', pattern: 'TODO', paths: [ROOT], filter: '*.ts' }]);
    expect(reads('rg -t ts -C 2 handler packages')[0]).toMatchObject({ pattern: 'handler', paths: [`${ROOT}/packages`], filter: 'type:ts' });
    expect(reads('rg --files src')).toEqual([{ tool: 'rg', kind: 'list', paths: [`${ROOT}/src`], filter: undefined }]);
  });

  test('find and ls list folders', () => {
    expect(reads("find src -name '*.test.ts'")).toEqual([{ tool: 'find', kind: 'list', paths: [`${ROOT}/src`], filter: '-name *.test.ts' }]);
    expect(reads('find -L . -type f')[0]).toMatchObject({ paths: [ROOT], filter: '-type f' });
    expect(reads('ls -la')).toEqual([{ tool: 'ls', kind: 'list', paths: [ROOT] }]);
    expect(reads('ls src docs')[0]).toMatchObject({ paths: [`${ROOT}/src`, `${ROOT}/docs`] });
  });

  test('a command that reads from a pipe filters, it does not read a file', () => {
    expect(reads('grep -rn "foo" src | head -20')).toEqual([{ tool: 'grep', kind: 'search', pattern: 'foo', paths: [`${ROOT}/src`], filter: undefined }]);
    expect(reads('cat a.ts | grep foo')).toEqual([{ tool: 'cat', kind: 'file', paths: [`${ROOT}/a.ts`] }]);
    expect(reads('git diff | grep foo')).toEqual([]);
  });

  test('formatting helpers keep a command read-only', () => {
    const analysis = analyzeBash("find . -type f -not -path './.git/*' | cut -d/ -f2 | sort | uniq -c | sort -rn | head -10; echo ---", ROOT);
    expect(analysis.readOnly).toBe(true);
    expect(analysis.reads).toHaveLength(1);
    expect(analyzeBash('wc -l src/*.ts', ROOT)).toEqual({ readOnly: true, reads: [], writes: [] });
  });

  test('cd changes the folder of the paths that follow', () => {
    expect(reads('cd src && cat db/orders.ts')).toEqual([{ tool: 'cat', kind: 'file', paths: [`${ROOT}/src/db/orders.ts`] }]);
    expect(reads('cd /abs/server && grep -n "x" hmr.ts middlewares/*.ts | head')[0]).toMatchObject({
      paths: ['/abs/server/hmr.ts', '/abs/server/middlewares/*.ts'],
    });
  });

  test('redirects to /dev/null and descriptor copies do not write', () => {
    expect(analyzeBash('cat a.ts 2>/dev/null', ROOT)).toMatchObject({ readOnly: true, writes: [] });
    expect(analyzeBash('grep -r x src 2>&1', ROOT)).toMatchObject({ readOnly: true, writes: [] });
  });
});

describe('analyzeBash: commands that are not read-only', () => {
  test('a redirect to a file writes it, and the reads no longer count', () => {
    expect(analyzeBash('cat src/checkout.ts > /tmp/copy.ts', ROOT)).toEqual({ readOnly: false, reads: [], writes: ['/tmp/copy.ts'] });
    expect(analyzeBash('echo x >> notes.md', ROOT).writes).toEqual([`${ROOT}/notes.md`]);
    expect(analyzeBash('make &> build.log', ROOT).writes).toEqual([`${ROOT}/build.log`]);
  });

  test('sed -i writes its files; sed without -n is outside the read-only list', () => {
    expect(analyzeBash("sed -i 's/a/b/' x.ts", ROOT)).toEqual({ readOnly: false, reads: [], writes: [`${ROOT}/x.ts`] });
    expect(analyzeBash("sed -i '' 's/a/b/' x.ts", ROOT).writes).toEqual([`${ROOT}/x.ts`]);
    expect(analyzeBash("sed 's/a/b/' x.ts", ROOT)).toEqual({ readOnly: false, reads: [], writes: [] });
  });

  test('tee, touch, rm, mv, cp and sort -o write files', () => {
    expect(analyzeBash('ls | tee list.txt', ROOT).writes).toEqual([`${ROOT}/list.txt`]);
    expect(analyzeBash('touch a; rm -f b; mv c d; cp e f', ROOT).writes).toEqual(['a', 'b', 'c', 'd', 'f'].map((f) => `${ROOT}/${f}`));
    expect(analyzeBash('sort -o out.txt in.txt', ROOT).writes).toEqual([`${ROOT}/out.txt`]);
  });

  test('find with actions that run or delete is not read-only', () => {
    expect(analyzeBash("find . -name '*.tmp' -delete", ROOT).readOnly).toBe(false);
    expect(analyzeBash('find . -exec rm {} \\;', ROOT).readOnly).toBe(false);
  });

  test('programs outside the list are not read-only', () => {
    for (const command of ['pnpm test', 'git log --oneline', 'node script.js', 'cat a && npm run build', 'xargs cat']) {
      expect(analyzeBash(command, ROOT), command).toEqual({ readOnly: false, reads: [], writes: [] });
    }
  });

  test('a command that cannot be analyzed is not read-only', () => {
    expect(analyzeBash('cat $(git ls-files)', ROOT)).toEqual({ readOnly: false, reads: [], writes: [] });
  });
});
