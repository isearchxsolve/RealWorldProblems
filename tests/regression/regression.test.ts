/**
 * SCENARIO_DEFECT_REGRESSION (regression)
 *
 * Repository-level entry point reproducing the defect reported in issue #1555
 * (family health document vault willingness-to-pay). The scenario implementation
 * lives next to the api workspace module it covers; this file exposes it at the
 * canonical `tests/regression` path.
 */
import '../../api/src/experiments/__tests__/regression.test';
