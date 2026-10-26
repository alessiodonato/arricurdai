import { z } from 'zod';

/**
 * Parameters of the cost model, as written in `arricurdai.config.json`.
 * All prices are relative to the price of one input token.
 */
export const costParamsSchema = z.strictObject({
  /** Multiplier for writing a token to the 5-minute prompt cache. */
  w: z.number().nonnegative().default(1.25),
  /** Multiplier for writing a token to the 1-hour prompt cache. Claude Code main sessions use it. */
  w1h: z.number().nonnegative().default(2),
  /** Multiplier for reading a token from the prompt cache. */
  r: z.number().nonnegative().default(0.1),
  /** Ratio between the output price and the input price. */
  mu: z.number().nonnegative().default(5),
  /** Tokens of one extra round trip: tool call, tool result and reply. */
  overhead: z.number().nonnegative().default(300),
});

export type CostParams = z.output<typeof costParamsSchema>;

export const DEFAULT_COST_PARAMS: CostParams = Object.freeze(costParamsSchema.parse({}));

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Validates the content of a config file and fills in the defaults.
 * `undefined` (no file) gives the defaults. Throws a ConfigError that names every invalid field.
 */
export function parseCostParams(input: unknown): CostParams {
  const result = costParamsSchema.safeParse(input ?? {});
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : 'config';
    return `${where}: ${issue.message}`;
  });
  throw new ConfigError(`Invalid arricurdai config. ${problems.join('; ')}`);
}
