/**
 * SCENARIO_CONCURRENCY_RACE (concurrency)
 *
 * Repository-level entry point for the concurrency scenario. The scenario
 * implementation lives next to the api workspace module it covers; this file
 * exposes it at the canonical `tests/concurrency` path.
 */
import '../../api/src/experiments/__tests__/concurrency.test';
