# Scenario test entry points

These directories expose the repository-level scenario suites required for the
delivery of issue #1020 (multi-contractor home renovation scheduling and payment
milestones):

| Scenario | Path |
|---|---|
| SCENARIO_HAPPY_PATH | `tests/happy_path` |
| SCENARIO_NULL_INPUT | `tests/boundary` |
| SCENARIO_EMPTY_INPUT | `tests/boundary` |
| SCENARIO_BOUNDARY_LIMIT | `tests/boundary` |
| SCENARIO_NEGATIVE_FAILURE | `tests/negative` |
| SCENARIO_CONCURRENCY_RACE | `tests/concurrency` |
| SCENARIO_DEFECT_REGRESSION | `tests/regression` |

Each file here is a thin entry point that imports the scenario suite that lives
next to the domain module it covers in the api workspace
(`api/src/renovation/renovationCoordinator.ts`).

Run the scenario suites from the repository root:

```bash
yarn test:scenarios
```

Run the full api workspace suite (which includes the same scenario suites):

```bash
yarn api:test
```
