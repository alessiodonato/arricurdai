/**
 * Estimated tokens of a text: characters / 4, rounded up.
 *
 * Every token estimate in arricurdAI goes through this function, so a real tokenizer can replace it
 * in one place. `text.length` counts UTF-16 code units, which is close enough for an estimate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
