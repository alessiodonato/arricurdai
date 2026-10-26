import { describe, expect, test } from 'vitest';
import { estimateTokens } from '../src/index';

describe('estimateTokens: characters / 4, rounded up', () => {
  test('counts an empty text as 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('rounds partial tokens up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
  });

  test('counts UTF-16 code units', () => {
    expect(estimateTokens('€€€€')).toBe(1);
    expect(estimateTokens('😀😀')).toBe(1);
  });
});
