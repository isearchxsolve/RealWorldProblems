import {
  ExperimentValidationError,
  WillingnessToPayExperiment,
  handleExperimentHttpRequest
} from '../willingnessToPay';

describe('SCENARIO_CONCURRENCY_RACE: concurrent requests transition atomically with zero double-spend', () => {
  it('registers exactly one sign-up for the same email under concurrency', async () => {
    const experiment = new WillingnessToPayExperiment();
    experiment.recordVisit({ visitorId: 'v-race', channel: 'race' });

    const attempts = Array.from({ length: 25 }, (_, index) =>
      Promise.resolve().then(() =>
        experiment.signUp({ email: 'race@example.com', tier: 'plus', channel: `attempt-${index}` })
      )
    );

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(24);
    for (const result of rejected) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ExperimentValidationError);
        expect((result.reason as ExperimentValidationError).code).toBe('DUPLICATE_SIGNUP');
      }
    }

    const metrics = experiment.getMetrics();
    expect(metrics.signups).toBe(1);
    expect(metrics.paidSignups).toBe(1);
    expect(metrics.tierBreakdown).toEqual({ free: 0, basic: 0, plus: 1 });
  });

  it('de-duplicates repeated concurrent visits for the same visitor id', async () => {
    const experiment = new WillingnessToPayExperiment();

    const attempts = Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => experiment.recordVisit({ visitorId: 'same-visitor', channel: 'race' }))
    );

    await Promise.all(attempts);
    expect(experiment.getMetrics().uniqueVisitors).toBe(1);
  });

  it('accepts concurrent distinct sign-ups without losing any', async () => {
    const experiment = new WillingnessToPayExperiment();

    const attempts = Array.from({ length: 30 }, (_, index) =>
      Promise.resolve().then(() => experiment.signUp({ email: `distinct-${index}@example.com`, tier: 'free', channel: 'race' }))
    );

    const settled = await Promise.allSettled(attempts);
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(experiment.getMetrics().signups).toBe(30);
  });

  it('rejects the second concurrent HTTP sign-up for the same email with 409 and no double-spend', async () => {
    const experiment = new WillingnessToPayExperiment();

    const responses = await Promise.all([
      Promise.resolve().then(() =>
        handleExperimentHttpRequest(experiment, {
          method: 'POST',
          path: '/signups',
          body: { email: 'http-race@example.com', tier: 'basic', channel: 'race' }
        })
      ),
      Promise.resolve().then(() =>
        handleExperimentHttpRequest(experiment, {
          method: 'POST',
          path: '/signups',
          body: { email: 'http-race@example.com', tier: 'plus', channel: 'race' }
        })
      )
    ]);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(experiment.getMetrics().signups).toBe(1);
    expect(experiment.getMetrics().paidSignups).toBe(1);
  });
});
