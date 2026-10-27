import {
  CONVERSION_PASS_RATE,
  PAID_TIER_PASS_SHARE,
  RECRUITING_CHANNELS,
  WillingnessToPayExperiment,
  handleExperimentHttpRequest,
  listTierOptions
} from '../willingnessToPay';

function seedVisitors(experiment: WillingnessToPayExperiment, count: number): void {
  for (let index = 0; index < count; index += 1) {
    experiment.recordVisit({
      visitorId: `visitor-${index}`,
      channel: RECRUITING_CHANNELS[index % RECRUITING_CHANNELS.length]
    });
  }
}

describe('SCENARIO_HAPPY_PATH: family health documents willingness-to-pay landing page test', () => {
  it('records unique visitors and waitlist sign-ups with a forced tier selection', () => {
    const experiment = new WillingnessToPayExperiment();

    seedVisitors(experiment, 320);

    const paidSignup = experiment.signUp({
      email: 'Parent.One@Example.com',
      tier: 'basic',
      channel: 'school-parent-facebook-group',
      visitorId: 'visitor-1'
    });

    expect(paidSignup.email).toBe('parent.one@example.com');
    expect(paidSignup.tierId).toBe('basic');
    expect(paidSignup.visitorId).toBe('visitor-1');

    const metrics = experiment.getMetrics();
    expect(metrics.uniqueVisitors).toBe(320);
    expect(metrics.signups).toBe(1);
    expect(metrics.paidSignups).toBe(1);
    expect(metrics.selectedMonthlyPriceGbp).toBe(3.99);
  });

  it('completes the full business path and returns a PASS decision above both thresholds', () => {
    const experiment = new WillingnessToPayExperiment();
    seedVisitors(experiment, 320);

    // 20 sign-ups out of 320 visitors (6.25%) with 5 paid selections (25%).
    for (let index = 0; index < 15; index += 1) {
      experiment.signUp({ email: `free-${index}@example.com`, tier: 'free', channel: 'mumsnet' });
    }
    for (let index = 0; index < 5; index += 1) {
      experiment.signUp({
        email: `paid-${index}@example.com`,
        tier: index % 2 === 0 ? 'plus' : 'basic',
        channel: 'mumsnet'
      });
    }

    const decision = experiment.decide();

    expect(decision.status).toBe('PASS');
    expect(decision.metrics.conversionRate).toBeGreaterThanOrEqual(CONVERSION_PASS_RATE);
    expect(decision.metrics.paidShare).toBeGreaterThanOrEqual(PAID_TIER_PASS_SHARE);
    expect(decision.reasons).toContain('conversion-at-or-above-pass-threshold');
    expect(decision.reasons).toContain('paid-intent-at-or-above-pass-threshold');
    expect(decision.metrics.selectedMonthlyPriceGbp).toBeGreaterThan(0);
  });

  it('presents the three issue #1647 tiers with the exact advertised prices', () => {
    const tiers = listTierOptions();

    expect(tiers).toHaveLength(3);
    expect(tiers.map((tier) => tier.id)).toEqual(['free', 'basic', 'plus']);
    expect(tiers.find((tier) => tier.id === 'free')?.priceLabel).toBe('£0');
    expect(tiers.find((tier) => tier.id === 'basic')?.priceLabel).toBe('£3.99/month');
    expect(tiers.find((tier) => tier.id === 'plus')?.priceLabel).toBe('£6.99/month');
  });

  it('serves the campaign over HTTP with 200 responses for the happy path', () => {
    const experiment = new WillingnessToPayExperiment();
    const adminToken = 'test-admin-token';

    const visitResponse = handleExperimentHttpRequest(experiment, {
      method: 'POST',
      path: '/visits',
      body: { visitorId: 'visitor-http', channel: 'babycentre-uk' }
    });

    const signupResponse = handleExperimentHttpRequest(experiment, {
      method: 'POST',
      path: '/signups',
      body: { email: 'http@example.com', tier: 'plus', channel: 'babycentre-uk' }
    });

    const decisionResponse = handleExperimentHttpRequest(
      experiment,
      { method: 'GET', path: '/decision', authorization: `Bearer ${adminToken}` },
      { adminToken }
    );

    expect(visitResponse.status).toBe(200);
    expect(signupResponse.status).toBe(200);
    expect(decisionResponse.status).toBe(200);
    expect(visitResponse.jsonBody).toMatchObject({ ok: true });
    expect(signupResponse.jsonBody).toMatchObject({ ok: true });
    expect(decisionResponse.jsonBody).toMatchObject({ ok: true });
  });
});
