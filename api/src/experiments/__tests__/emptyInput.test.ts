import {
  ExperimentValidationError,
  WillingnessToPayExperiment,
  handleExperimentHttpRequest
} from '../willingnessToPay';

function expectValidationError(fn: () => unknown): ExperimentValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExperimentValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected an ExperimentValidationError but no error was thrown');
}

describe('SCENARIO_EMPTY_INPUT: empty strings and whitespace-only inputs are rejected with a clear diagnostic', () => {
  const experiment = new WillingnessToPayExperiment();

  it('rejects empty and whitespace-only visit identifiers', () => {
    expect(expectValidationError(() => experiment.recordVisit({ visitorId: '', channel: 'reddit' })).code).toBe('EMPTY_VALUE');
    expect(expectValidationError(() => experiment.recordVisit({ visitorId: '   ', channel: 'reddit' })).code).toBe('EMPTY_VALUE');
    expect(expectValidationError(() => experiment.recordVisit({ visitorId: 'v1', channel: '\t' })).code).toBe('EMPTY_VALUE');
  });

  it('rejects empty and whitespace-only sign-up fields', () => {
    expect(expectValidationError(() => experiment.signUp({ email: '', tier: 'free', channel: 'reddit' })).code).toBe('EMPTY_VALUE');
    expect(expectValidationError(() => experiment.signUp({ email: '   ', tier: 'free', channel: 'reddit' })).code).toBe('EMPTY_VALUE');
    expect(expectValidationError(() => experiment.signUp({ email: 'a@b.co', tier: '', channel: 'reddit' })).code).toBe('EMPTY_VALUE');
    expect(expectValidationError(() => experiment.signUp({ email: 'a@b.co', tier: 'free', channel: '  ' })).code).toBe('EMPTY_VALUE');
  });

  it('produces a diagnostic message naming the offending field', () => {
    const error = expectValidationError(() => experiment.signUp({ email: 'a@b.co', tier: 'free', channel: ' ' }));
    expect(error.message).toContain('channel');
    expect(error.details).toMatchObject({ field: 'channel' });
  });

  it('rejects empty payloads over HTTP with a 400 and a machine-readable code', () => {
    const emptyBody = handleExperimentHttpRequest(experiment, { method: 'POST', path: '/signups', body: {} });
    const blankValue = handleExperimentHttpRequest(experiment, {
      method: 'POST',
      path: '/visits',
      body: { visitorId: '   ', channel: '' }
    });

    expect(emptyBody.status).toBe(400);
    expect(emptyBody.jsonBody).toMatchObject({ ok: false, code: 'MISSING_FIELD' });
    expect(blankValue.status).toBe(400);
    expect(blankValue.jsonBody).toMatchObject({ ok: false, code: 'EMPTY_VALUE' });
  });

  it('never silently corrupts state on empty input', () => {
    const fresh = new WillingnessToPayExperiment();
    expectValidationError(() => fresh.recordVisit({ visitorId: '', channel: 'reddit' }));
    expectValidationError(() => fresh.signUp({ email: '', tier: 'free', channel: 'reddit' }));

    const metrics = fresh.getMetrics();
    expect(metrics.uniqueVisitors).toBe(0);
    expect(metrics.signups).toBe(0);
    expect(metrics.tierBreakdown).toEqual({ free: 0, basic: 0, plus: 0 });
  });
});
