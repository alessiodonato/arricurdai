import { describe, expect, test } from 'vitest';
import { ConfigError, DEFAULT_COST_PARAMS, parseCostParams } from '../src/index';

describe('parseCostParams', () => {
  test('gives the defaults when there is no config', () => {
    expect(parseCostParams(undefined)).toEqual({ w: 1.25, w1h: 2, r: 0.1, mu: 5, overhead: 300 });
    expect(parseCostParams({})).toEqual(DEFAULT_COST_PARAMS);
  });

  test('keeps the defaults for the fields it is not given', () => {
    expect(parseCostParams({ r: 0.08, overhead: 500 })).toEqual({ w: 1.25, w1h: 2, r: 0.08, mu: 5, overhead: 500 });
  });

  test('names the field with the wrong type', () => {
    expect(() => parseCostParams({ w: '1.25' })).toThrow(ConfigError);
    expect(() => parseCostParams({ w: '1.25' })).toThrow(/w:/);
  });

  test('rejects negative values', () => {
    expect(() => parseCostParams({ overhead: -1 })).toThrow(/overhead:/);
  });

  test('rejects unknown keys, so a typo is not silently ignored', () => {
    expect(() => parseCostParams({ W: 1.3 })).toThrow(/"W"/);
  });

  test('rejects a config that is not an object', () => {
    expect(() => parseCostParams(42)).toThrow(ConfigError);
    expect(() => parseCostParams([1, 2])).toThrow(ConfigError);
  });

  test('cannot change the defaults by accident', () => {
    expect(Object.isFrozen(DEFAULT_COST_PARAMS)).toBe(true);
  });
});
