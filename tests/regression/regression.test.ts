/**
 * SCENARIO_DEFECT_REGRESSION (regression)
 *
 * Repository-level entry point reproducing the defect reported in issue #1614.
 * The scenario implementation lives next to the api workspace module it covers;
 * this file exposes it at the canonical `tests/regression` path.
 */
import '../../api/src/experiments/__tests__/regression.test';
