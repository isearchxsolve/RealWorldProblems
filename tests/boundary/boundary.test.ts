/**
 * SCENARIO_NULL_INPUT / SCENARIO_EMPTY_INPUT / SCENARIO_BOUNDARY_LIMIT
 * (boundary)
 *
 * Repository-level entry point for the boundary scenarios (null, empty and
 * exact upper/lower bound values). The scenario implementation lives next to the
 * api workspace module it covers; this file exposes it at the canonical
 * `tests/boundary` path.
 */
import '../../api/src/__tests__/renovation/boundary.test';
