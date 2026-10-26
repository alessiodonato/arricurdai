import { expect, test } from 'vitest';
import { checkPackage } from '../../../test-support/no-network';

test('the CLI imports no network module; the only process it starts is git, which reads local history', () => {
  const allowed = [
    'node:child_process', 'node:fs', 'node:module', 'node:path', 'node:util',
    'commander', 'picocolors', '@arricurdai/core', '@arricurdai/transcripts',
  ];
  const check = checkPackage(new URL('..', import.meta.url).pathname, allowed);
  expect(check).toEqual({ forbiddenImports: [], networkCalls: [], forbiddenDependencies: [] });
});
