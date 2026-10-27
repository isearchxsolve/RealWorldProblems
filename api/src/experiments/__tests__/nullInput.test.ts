import {
  ExperimentValidationError,
  WillingnessToPayExperiment,
  handleExperimentHttpRequest,
  normalizeEmail,
  requireNonEmptyString,
  resolveTier
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

describe('SCENARIO_NULL_INPUT: null / undefined causes an explicit validation error, never a crash', () => {
  const experiment = new WillingnessToPayExperiment();

  it('rejects null and undefined visits with MISSING_FIELD', () => {
    expect(expectValidationError(() => experiment.recordVisit(null)).code).toBe('MISSING_FIELD');
    expect(expectValidationError(() => experiment.recordVisit(undefined)).code).toBe('MISSING_FIELD');
    expect(expectValidationError(() => experiment.recordVisit({})).code).toBe('MISSING_FIELD');
  });

  it('rejects null and undefined sign-ups with MISSING_FIELD', () => {
    expect(expectValidationError(() => experiment.signUp(null)).code).toBe('MISSING_FIELD');
    expect(expectValidationError(() => experiment.signUp(undefined)).code).toBe('MISSING_FIELD');
    expect(
      expectValidationError(() => experiment.signUp({ tier: 'free', channel: 'mumsnet' })).details
    ).toMatchObject({ field: 'email' });
  });

  it('refuses a sign-up with no tier instead of defaulting the tier selection', () => {
    const missingTier = expectValidationError(() =>
      experiment.signUp({ email: 'no-tier@example.com', channel: 'mumsnet' })
    );

    expect(missingTier.code).toBe('MISSING_FIELD');
    expect(missingTier.details).toMatchObject({ field: 'tier' });
    expect(experiment.getMetrics().signups).toBe(0);
  });

  it('exposes typed errors with a 400 status instead of throwing unhandled exceptions', () => {
    const error = expectValidationError(() => experiment.signUp(null));
    expect(error).toBeInstanceOf(ExperimentValidationError);
    expect(error.name).toBe('ExperimentValidationError');
    expect(error.status).toBe(400);
  });

  it('handles null arguments for the shared validators', () => {
    expect(expectValidationError(() => requireNonEmptyString(null, 'channel')).code).toBe('MISSING_FIELD');
    expect(expectValidationError(() => normalizeEmail(undefined)).code).toBe('MISSING_FIELD');
    expect(expectValidationError(() => resolveTier(null)).code).toBe('MISSING_FIELD');
  });

  it('returns a 400 diagnostic over HTTP when the request or body is null', () => {
    const nullRequest = handleExperimentHttpRequest(experiment, null);
    const nullBody = handleExperimentHttpRequest(experiment, { method: 'POST', path: '/visits', body: null });

    expect(nullRequest.status).toBe(400);
    expect(nullRequest.jsonBody).toMatchObject({ ok: false, code: 'MISSING_FIELD' });
    expect(nullBody.status).toBe(400);
    expect(nullBody.jsonBody).toMatchObject({ ok: false, code: 'MISSING_FIELD' });
  });

  it('does not mutate experiment state when validation fails', () => {
    expect(experiment.getMetrics()).toEqual({
      uniqueVisitors: 0,
      signups: 0,
      paidSignups: 0,
      freeSignups: 0,
      conversionRate: 0,
      paidShare: 0,
      tierBreakdown: { free: 0, basic: 0, plus: 0 },
      selectedMonthlyPriceGbp: 0
    });
  });
});
