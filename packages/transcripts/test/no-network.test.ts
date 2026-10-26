import { expect, test } from 'vitest';
import { checkPackage } from '../../../test-support/no-network';

test('transcripts imports no network module and calls no network API', () => {
  const allowed = ['node:crypto', 'node:fs', 'node:os', 'node:path', 'node:readline', 'zod', '@arricurdai/core'];
  const check = checkPackage(new URL('..', import.meta.url).pathname, allowed);
  expect(check).toEqual({ forbiddenImports: [], networkCalls: [], forbiddenDependencies: [] });
});
