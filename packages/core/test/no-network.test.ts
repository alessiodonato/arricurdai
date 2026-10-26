import { expect, test } from 'vitest';
import { checkPackage } from '../../../test-support/no-network';

test('core imports no network module and calls no network API', () => {
  const check = checkPackage(new URL('..', import.meta.url).pathname, ['node:path', 'zod']);
  expect(check).toEqual({ forbiddenImports: [], networkCalls: [], forbiddenDependencies: [] });
});
