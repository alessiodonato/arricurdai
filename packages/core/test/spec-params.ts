import { parseCostParams } from '../src/config';

/** The parameters the specification gives its examples with: the cache-read price of Claude 4 models. */
export const SPEC_PARAMS = parseCostParams({ r: 0.1 });
