import {
  ExperimentValidationError,
  WillingnessToPayExperiment,
  handleExperimentHttpRequest,
  resolveTier
} from '../familyHealthVaultWtp';

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

describe('SCENARIO_NEGATIVE_FAILURE: malformed data and unauthorized callers are refused with typed errors', () => {
  const experiment = new WillingnessToPayExperiment();
  const adminToken = 'test-admin-token';

  it('refuses malformed email addresses with INVALID_EMAIL', () => {
    const error = expectValidationError(() => experiment.signUp({ email: 'not-an-email', tier: 'free', channel: 'mumsnet' }));
    expect(error.code).toBe('INVALID_EMAIL');
    expect(error.status).toBe(400);
    expect(experiment.getMetrics().signups).toBe(0);
  });

  it('refuses unknown pricing tiers with UNKNOWN_TIER and lists the allowed tiers', () => {
    const error = expectValidationError(() => resolveTier('platinum'));
    expect(error.code).toBe('UNKNOWN_TIER');
    expect(error.details).toMatchObject({ allowed: ['free', 'basic', 'plus'] });
  });

  it('refuses unhealthy numeric types instead of coercing them', () => {
    const error = expectValidationError(() =>
      experiment.signUp({ email: 42, tier: 'free', channel: 'mumsnet' })
    );
    expect(error.code).toBe('EMPTY_VALUE');
    expect(error.details).toMatchObject({ field: 'email', receivedType: 'number' });
  });

  it('refuses metrics reads without an admin credential (401)', () => {
    const missing = handleExperimentHttpRequest(experiment, { method: 'GET', path: '/decision' }, { adminToken });
    const wrong = handleExperimentHttpRequest(
      experiment,
      { method: 'GET', path: '/decision', authorization: 'Bearer not-the-token' },
      { adminToken }
    );

    expect(missing.status).toBe(401);
    expect(missing.jsonBody).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect(wrong.status).toBe(401);
    expect(wrong.jsonBody).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
  });

  it('refuses an unconfigured admin token even if the caller presents a bearer token', () => {
    const response = handleExperimentHttpRequest(
      experiment,
      { method: 'GET', path: '/decision', authorization: 'Bearer anything' },
      { adminToken: '' }
    );
    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses malformed requests and unsupported routes with NOT_FOUND', () => {
    const badMethod = handleExperimentHttpRequest(experiment, { method: 'DELETE', path: '/signups' });
    const badPath = handleExperimentHttpRequest(experiment, { method: 'GET', path: '/metrics' });
    const noMethod = handleExperimentHttpRequest(experiment, { path: '/signups' });

    expect(badMethod.status).toBe(404);
    expect(badMethod.jsonBody).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(badPath.status).toBe(404);
    expect(noMethod.status).toBe(400);
  });

  it('surfaces duplicate waitlist submissions as DUPLICATE_SIGNUP (409)', () => {
    const single = new WillingnessToPayExperiment();
    single.signUp({ email: 'dup@example.com', tier: 'free', channel: 'mumsnet' });
    const duplicate = expectValidationError(() => single.signUp({ email: 'dup@example.com', tier: 'plus', channel: 'mumsnet' }));
    expect(duplicate.code).toBe('DUPLICATE_SIGNUP');
    expect(duplicate.status).toBe(409);
  });
});
