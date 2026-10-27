/**
 * SCENARIO_NEGATIVE_FAILURE (negative)
 *
 * Repository-level entry point for the negative scenario (malformed data and
 * unauthorized callers). The scenario implementation lives next to the api
 * workspace module it covers; this file exposes it at the canonical
 * `tests/negative` path.
 */
import '../../api/src/experiments/__tests__/negative.test';
