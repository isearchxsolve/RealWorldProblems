import {
  EXPERIMENT_TIERS,
  PAID_TIER_PRICE_MAX_GBP,
  PAID_TIER_PRICE_MIN_GBP,
  TRAFFIC_MIN_VISITORS,
  TRAFFIC_TARGET_MAX_VISITORS,
  WillingnessToPayExperiment
} from '../familyHealthVaultWtp';

function seed(visitors: number, signups: number, paid: number): WillingnessToPayExperiment {
  const experiment = new WillingnessToPayExperiment();
  for (let index = 0; index < visitors; index += 1) {
    experiment.recordVisit({ visitorId: `v-${index}`, channel: 'boundary' });
  }
  for (let index = 0; index < signups; index += 1) {
    experiment.signUp({
      email: `signup-${index}@example.com`,
      tier: index < paid ? 'basic' : 'free',
      channel: 'boundary'
    });
  }
  return experiment;
}

describe('SCENARIO_BOUNDARY_LIMIT: exact threshold ticks use half-open interval semantics', () => {
  it('treats 300 visitors (>= minimum) as sufficient traffic and 299 as insufficient', () => {
    expect(TRAFFIC_MIN_VISITORS).toBe(300);

    const atBoundary = seed(TRAFFIC_MIN_VISITORS, 15, 4).decide();
    const belowBoundary = seed(TRAFFIC_MIN_VISITORS - 1, 15, 4).decide();

    expect(atBoundary.status).toBe('PASS');
    expect(belowBoundary.status).toBe('INCONCLUSIVE');
    expect(belowBoundary.reasons).toContain('insufficient-traffic:299/300');
  });

  it('accepts exactly 5% conversion as PASS (>= is inclusive)', () => {
    const decision = seed(300, 15, 4).decide();
    expect(decision.metrics.conversionRate).toBe(0.05);
    expect(decision.status).toBe('PASS');
  });

  it('rejects 299 viewers even when the conversion ratio would otherwise pass', () => {
    // 15 / 299 = 5.02%, above the conversion threshold but an invalid sample.
    const decision = seed(299, 15, 15).decide();
    expect(decision.metrics.conversionRate).toBeGreaterThan(0.05);
    expect(decision.status).toBe('INCONCLUSIVE');
  });

  it('treats exactly 3% conversion as not-yet-failed (fail is strictly below 3%)', () => {
    const decision = seed(300, 9, 9).decide();
    expect(decision.metrics.conversionRate).toBe(0.03);
    expect(decision.status).toBe('INCONCLUSIVE');
    expect(decision.reasons).toContain('conversion-between-thresholds');
  });

  it('fails strictly below the 3% conversion floor', () => {
    const decision = seed(300, 8, 0).decide();
    expect(decision.metrics.conversionRate).toBeLessThan(0.03);
    expect(decision.status).toBe('FAIL');
    expect(decision.reasons).toContain('conversion-below-fail-threshold');
  });

  it('accepts exactly 25% paid-tier share as PASS (>= is inclusive)', () => {
    const decision = seed(300, 20, 5).decide();
    expect(decision.metrics.paidShare).toBe(0.25);
    expect(decision.status).toBe('PASS');
  });

  it('treats exactly 10% paid-tier share as not-yet-failed and 9% as FAIL', () => {
    const atBoundary = seed(300, 20, 2).decide();
    const belowBoundary = seed(300, 100, 9).decide();

    expect(atBoundary.metrics.paidShare).toBe(0.1);
    expect(atBoundary.status).toBe('INCONCLUSIVE');

    expect(belowBoundary.metrics.paidShare).toBeLessThan(0.1);
    expect(belowBoundary.status).toBe('FAIL');
    expect(belowBoundary.reasons).toContain('paid-intent-below-fail-threshold');
  });

  it('keeps the advertised paid tier prices inside the validated £2.99-4.99 range', () => {
    const paidTiers = EXPERIMENT_TIERS.filter((tier) => tier.paid);
    expect(paidTiers).toHaveLength(2);
    for (const tier of paidTiers) {
      expect(tier.monthlyPriceGbp).toBeGreaterThanOrEqual(PAID_TIER_PRICE_MIN_GBP);
      expect(tier.monthlyPriceGbp).toBeLessThanOrEqual(PAID_TIER_PRICE_MAX_GBP);
    }
    const freeTier = EXPERIMENT_TIERS.find((tier) => !tier.paid);
    expect(freeTier?.monthlyPriceGbp).toBe(0);
    expect(PAID_TIER_PRICE_MIN_GBP).toBe(2.99);
    expect(PAID_TIER_PRICE_MAX_GBP).toBe(4.99);
  });

  it('still resolves a decision at the upper end of the traffic target', () => {
    const decision = seed(TRAFFIC_TARGET_MAX_VISITORS, 20, 5).decide();
    expect(TRAFFIC_TARGET_MAX_VISITORS).toBe(400);
    expect(decision.metrics.uniqueVisitors).toBe(400);
    expect(decision.status).toBe('PASS');
  });
});
