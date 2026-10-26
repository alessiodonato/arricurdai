import { type CostParams, DEFAULT_COST_PARAMS } from './config';

/** Token counts of one API call, or the sum of several, as the usage fields of a transcript give them. */
export interface Usage {
  input: number;
  /** All cache writes (`cache_creation_input_tokens`). */
  cacheWrite: number;
  /** The part of `cacheWrite` that went to the 5-minute cache, when the transcript says. */
  cacheWrite5m?: number;
  /** The part of `cacheWrite` that went to the 1-hour cache, when the transcript says. */
  cacheWrite1h?: number;
  cacheRead: number;
  output: number;
}

/** How long the prompt cache keeps a block. It sets the price of writing the block. */
export type CacheTtl = '5m' | '1h';

function assertCount(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0, got ${value}`);
  }
}

/** Price of writing one token to the cache with the given TTL. */
export function writeMultiplier(ttl: CacheTtl, params: CostParams = DEFAULT_COST_PARAMS): number {
  return ttl === '1h' ? params.w1h : params.w;
}

/** Adds up the usage of several API calls. */
export function sumUsage(usages: Iterable<Usage>): Usage {
  const total = { input: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  for (const usage of usages) {
    total.input += usage.input;
    total.cacheWrite += usage.cacheWrite;
    total.cacheWrite5m += usage.cacheWrite5m ?? 0;
    total.cacheWrite1h += usage.cacheWrite1h ?? 0;
    total.cacheRead += usage.cacheRead;
    total.output += usage.output;
  }
  return total;
}

/**
 * Price-weighted tokens: K = in + w·cw + r·cr + mu·out.
 *
 * Writes to the 1-hour cache cost `w1h` instead of `w`. Writes with no TTL split cost `w`, so with
 * `w1h = w`, or with no split in the usage, this is exactly the formula above.
 */
export function weightedCost(usage: Usage, params: CostParams = DEFAULT_COST_PARAMS): number {
  const write5m = usage.cacheWrite5m ?? 0;
  const write1h = usage.cacheWrite1h ?? 0;
  assertCount(usage.input, 'usage.input');
  assertCount(usage.cacheWrite, 'usage.cacheWrite');
  assertCount(write5m, 'usage.cacheWrite5m');
  assertCount(write1h, 'usage.cacheWrite1h');
  assertCount(usage.cacheRead, 'usage.cacheRead');
  assertCount(usage.output, 'usage.output');
  const unsplit = Math.max(0, usage.cacheWrite - write5m - write1h);
  return (
    usage.input +
    params.w * (write5m + unsplit) +
    params.w1h * write1h +
    params.r * usage.cacheRead +
    params.mu * usage.output
  );
}

/** K_s: price-weighted cost of a session, from the usage of each of its API calls. */
export function sessionCost(usages: Iterable<Usage>, params: CostParams = DEFAULT_COST_PARAMS): number {
  return weightedCost(sumUsage(usages), params);
}

/**
 * Rent of a block of `tokens` that entered the context at turn t of a session with T turns:
 * C = c·(w + r·(T − t)). The block is written to the cache once, then read on each later turn.
 *
 * @param turnsAfter T − t, the turns after the one where the block entered.
 */
export function rent(
  tokens: number,
  turnsAfter: number,
  params: CostParams = DEFAULT_COST_PARAMS,
  ttl: CacheTtl = '5m',
): number {
  assertCount(tokens, 'tokens');
  assertCount(turnsAfter, 'turnsAfter');
  return tokens * (writeMultiplier(ttl, params) + params.r * turnsAfter);
}

/**
 * Rent per session of memory that is always loaded (CLAUDE.md, MEMORY.md):
 * C_mem = c_mem·(w + r·(T − 1)), because it enters at the first turn.
 *
 * @param turns T, the turns of the session.
 */
export function memoryRent(
  tokens: number,
  turns: number,
  params: CostParams = DEFAULT_COST_PARAMS,
  ttl: CacheTtl = '5m',
): number {
  if (!Number.isFinite(turns) || turns < 1) {
    throw new RangeError(`turns must be a finite number >= 1, got ${turns}`);
  }
  return rent(tokens, turns - 1, params, ttl);
}

export interface LoadNowInput {
  /** L: tokens already in the context. */
  contextTokens: number;
  /** p: probability that the block is needed later in the session, from 0 to 1. */
  probability: number;
  /** T − t: turns left after the current one. */
  turnsAfter: number;
}

/**
 * Size below which a block should be loaded now rather than on demand:
 * c < p·(r·L + overhead) / ((1 − p)·(w + r·(T − t))).
 *
 * Loading now always pays the rent. Waiting pays, with probability p, one more round trip that
 * reads the whole context again. Returns 0 when p = 0 and Infinity when p = 1.
 */
export function loadNowThreshold(
  input: LoadNowInput,
  params: CostParams = DEFAULT_COST_PARAMS,
  ttl: CacheTtl = '5m',
): number {
  const { contextTokens, probability, turnsAfter } = input;
  assertCount(contextTokens, 'contextTokens');
  assertCount(turnsAfter, 'turnsAfter');
  if (!(probability >= 0 && probability <= 1)) {
    throw new RangeError(`probability must be between 0 and 1, got ${probability}`);
  }
  if (probability === 1) return Infinity;
  const tripCost = params.r * contextTokens + params.overhead;
  return (probability * tripCost) / ((1 - probability) * (writeMultiplier(ttl, params) + params.r * turnsAfter));
}

/** True when a block of `tokens` costs less loaded now than fetched on demand. */
export function shouldLoadNow(
  tokens: number,
  input: LoadNowInput,
  params: CostParams = DEFAULT_COST_PARAMS,
  ttl: CacheTtl = '5m',
): boolean {
  assertCount(tokens, 'tokens');
  return tokens < loadNowThreshold(input, params, ttl);
}

/**
 * S_max = Σ rent of rediscoveries / Σ K_s: the share of the spend that went to rebuilding known
 * context. It is a ceiling on the savings, not a promise. Returns 0 when there is no spend.
 */
export function maxSavings(rediscoveryRents: Iterable<number>, sessionCosts: Iterable<number>): number {
  let rents = 0;
  for (const value of rediscoveryRents) {
    assertCount(value, 'rediscovery rent');
    rents += value;
  }
  let costs = 0;
  for (const value of sessionCosts) {
    assertCount(value, 'session cost');
    costs += value;
  }
  return costs === 0 ? 0 : rents / costs;
}
